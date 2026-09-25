// The run's record under ai-log/: timeline, verdicts, step files, raw exchanges, QA reports and the secret scan.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { clock, hashFile, listFiles, oneLine, pad, REQUEST, ROOT, sha, UNITS } from "./core.mjs";
import { renderFacts } from "./render.mjs";

// ---------- the work record (ai-log)
// Every run keeps a human-readable record in the project, written by the engine as the run goes:
//   ai-log/<YYYYMMDD>/<NNN>_<HHMMSS>_<name>/
//     00-request/      request.md: DENKEN's summary of the conversation (the raw conversation is in raw/)
//     01-planning/     METHODE <-> RICHTER, one numbered file per step
//     02-development/  STARK <-> UBEL, including recovery rounds after QA failures
//     03-qa/           GENAU's report and evidence, one folder per QA cycle
//     04-wiki/         SERIE <-> FRIEREN
//     raw/             every call's prompt, streamed log and output, as exchanged
//     timeline.md      every step, verdict, stop and resume, in order
//     verdicts.md      every submission and verdict exchanged, in the words it was given
export const STAGE_LOG = { plan: "01-planning", dev: "02-development", qa: "03-qa", wiki: "04-wiki" };

export const LOG_DIRS = ["00-request", ...Object.values(STAGE_LOG), "raw"];

// A unit's run keeps the parent's record, by absolute path, and writes into a folder of its own
// within each part of it: 01-planning/UNIT-1/, raw/UNIT-1/, and so on.
export const logDir = (state) => (state.log ? resolve(ROOT, state.log) : null);

export const logPart = (state, part) => (state.unit ? join(part, state.unit) : part);

export function createLog(name) {
  const d = new Date();
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
  const ignore = join(ROOT, "ai-log", ".gitignore");
  mkdirSync(join(ROOT, "ai-log"), { recursive: true });
  // Raw exchanges and QA evidence can hold secrets (environment dumps, tokens in logs): kept out of
  // git unless the team decides otherwise.
  if (!existsSync(ignore)) writeFileSync(ignore, "*/*/raw/\n*/*/03-qa/*/evidence/\n");
  const dayDir = join(ROOT, "ai-log", day);
  mkdirSync(dayDir, { recursive: true });
  const seq = Math.max(0, ...readdirSync(dayDir).map((f) => Number(f.match(/^(\d{3})_/)?.[1] ?? 0))) + 1;
  const title = String(name).normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "run";
  const dir = join(dayDir, `${pad(seq, 3)}_${d.toTimeString().slice(0, 8).replace(/:/g, "")}_${title}`);
  for (const sub of LOG_DIRS) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "timeline.md"), `# Timeline: ${name}\n\nEvery step, verdict, stop and resume of this run, in order.\n\n`);
  writeFileSync(join(dir, "verdicts.md"), VERDICTS_HEAD(name));
  return relative(ROOT, dir);
}

export function timeline(state, actor, text) {
  const dir = logDir(state);
  if (dir) appendFileSync(join(dir, "timeline.md"), `- ${clock()} · **${state.unit ? `${state.unit} · ` : ""}${actor}** · ${text}\n`);
}

// verdicts.md: one line per submission or verdict, with the words it was given in. The lines live
// in state.json and the file is rewritten from them on every entry, so the engine is its only
// writer: a copy changed by anyone else is kept in raw/, noted, and replaced.
export const STAGE_NAME = { plan: "Planning", dev: "Development", wiki: "Docs" };

export const VERDICTS_HEAD = (task) => `# Verdicts: ${task}\n\nEvery submission and verdict exchanged in this run, in order, in the words it was given. Each line links the step file that holds the full text. The engine alone writes this file.\n\n`;

export function verdict(state, label, who, word, text, { call = null, file = null, note = null } = {}) {
  const dir = logDir(state);
  if (!dir) return;
  const full = String(text ?? "").replace(/\s+/g, " ").trim();
  const shown = oneLine(full, 1000);
  writeVerdicts(state, `- ${clock()} · ${label} · ${who}${call ? ` · ${call}` : ""} · **${word}**${note ? ` (${note})` : ""} · ${shown}${shown.length < full.length ? " … (truncated)" : ""}${file ? ` → ${file}` : ""}`);
}

export function writeVerdicts(state, line) {
  state.verdicts ??= [];
  // A unit's lines are pulled into the parent's verdicts.md by the parent, the file's only writer.
  if (state.unit) return state.verdicts.push(line);
  const path = join(logDir(state), "verdicts.md");
  if (state.verdictsSha && hashFile(path) !== state.verdictsSha) {
    const kept = `raw/verdicts.changed-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.md`;
    if (existsSync(path)) copyFileSync(path, join(logDir(state), kept));
    state.verdicts.push(`- ${clock()} · Record · ENGINE · **RESTORED** · verdicts.md was changed outside the engine; it was rewritten from the engine's own record, and the changed copy kept → ${kept}`);
    timeline(state, "ENGINE", `verdicts.md was changed outside the engine: restored, changed copy kept → ${kept}`);
  }
  state.verdicts.push(line);
  const content = `${VERDICTS_HEAD(state.task)}${state.verdicts.join("\n")}\n`;
  writeFileSync(path, content);
  state.verdictsSha = sha(content);
}

// One numbered file per step in a stage folder; returns its path within the log.
export function logStep(state, stage, name, content) {
  const dir = logDir(state);
  if (!dir) return null;
  const part = logPart(state, STAGE_LOG[stage]);
  const folder = join(dir, part);
  mkdirSync(folder, { recursive: true });
  const n = readdirSync(folder).filter((f) => /^\d{2}_/.test(f)).length + 1;
  const file = `${pad(n, 2)}_${name}.md`;
  writeFileSync(join(folder, file), content);
  return `${part}/${file}`;
}

// Copies everything a call exchanged (prompt, job, streamed log, output, gaps, ticks, ...) to raw/.
export function logRaw(state, runDir, callId) {
  const dir = logDir(state);
  if (!dir) return;
  state.rawSeq = (state.rawSeq ?? 0) + 1;
  const raw = join(dir, logPart(state, "raw"));
  mkdirSync(raw, { recursive: true });
  for (const f of readdirSync(join(runDir, "calls"))) {
    const path = join(runDir, "calls", f);
    if (!f.startsWith(`${callId}.`)) continue;
    if (statSync(path).isFile()) copyFileSync(path, join(raw, `${pad(state.rawSeq, 3)}_${f}`));
    else if (f.endsWith(".tampered")) for (const t of listFiles(path)) {
      const target = join(raw, `${pad(state.rawSeq, 3)}_${f}`, relative(path, t));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(t, target);
    }
  }
}

// 00-request/request.md is DENKEN's request.md as it stands; the conversation it came from is kept
// verbatim in raw/.
export function logRequest(state, runDir) {
  const dir = logDir(state);
  if (!dir) return;
  mkdirSync(join(dir, logPart(state, "00-request")), { recursive: true });
  copyFileSync(join(runDir, REQUEST), join(dir, logPart(state, "00-request"), "request.md"));
  if (existsSync(join(runDir, UNITS)) && !state.unit) copyFileSync(join(runDir, UNITS), join(dir, "00-request", UNITS));
  if (existsSync(join(runDir, "conversation.md"))) copyFileSync(join(runDir, "conversation.md"), join(dir, "raw", "000_conversation.md"));
}

export function logQa(state, runDir, call, items, facts) {
  const dir = logDir(state);
  if (!dir) return;
  const folder = join(dir, logPart(state, STAGE_LOG.qa), `qa-${call.round}`);
  mkdirSync(join(folder, "evidence"), { recursive: true });
  const evidence = join(runDir, "calls", `${call.id}.evidence`);
  if (existsSync(evidence)) for (const f of listFiles(evidence)) {
    const target = join(folder, "evidence", relative(evidence, f));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(f, target);
  }
  const cell = (t) => oneLine(t, 300).replace(/\|/g, "\\|");
  const rows = items.map((c) => `| ${c.id} | ${c.request_item ?? ""} | ${c.result} | ${cell(c.check)} | ${cell(c.how_verified)} | ${cell(c.evidence)} | ${(c.evidence_files ?? []).map((f) => `\`${basename(f)}\``).join(", ")} |`);
  writeFileSync(join(folder, "report.md"), `# QA cycle ${call.round} · GENAU · ${call.provider}\n\nResult: **${items.every((c) => c.result === "PASS") ? "PASS" : "FAIL"}**\n\n| Item | Request | Result | Check | How verified | Evidence | Files |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n${renderFacts(facts)}`);
}

// Likely secrets in the record, reported by file, line and kind (never the value itself).
export const SECRET_PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["credential assignment", /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-\/+=]{16,}/i],
];

export function scanSecrets(state) {
  const dir = logDir(state);
  if (!dir) return [];
  const hits = [];
  for (const file of listFiles(dir)) {
    let text;
    try {
      if (statSync(file).size > 20 << 20) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      for (const [kind, re] of SECRET_PATTERNS) if (re.test(line)) hits.push({ file: relative(ROOT, file), line: i + 1, kind });
    });
  }
  return hits;
}

// Stops are logged once, when the run first blocks on them.
export function logStop(state) {
  const b = state.blocked;
  if (!b || state.loggedBlock === b.since) return;
  state.loggedBlock = b.since;
  const detail = [
    b.requests?.length ? b.requests.map((r) => `${r.need} (${r.why})`).join("; ") : null,
    b.identity ?? (b.identities ? b.identities.join(", ") : null),
    b.items ? b.items.map((i) => i.item).join(", ") : null,
    b.violations ? b.violations.join("; ") : null,
    b.error ? oneLine(b.error) : null,
    b.rule ?? null,
  ].filter(Boolean).join(" · ");
  const who = { ruling: "DENKEN is called in", permission: "DENKEN is called in to decide a permission", user: "waiting for the user" }[b.kind];
  timeline(state, "STOP", `${b.reason}${detail ? `: ${detail}` : ""} (${who})`);
}

// ---------- prompts
