#!/usr/bin/env node
// DENKEN run engine: a deterministic state machine for the stage loop.
// DENKEN (the LLM) handles intake, rulings and talking to the user. This script handles the rest:
// which call runs next, launching it as a separate agent process, guarding files, parsing
// verdicts, counting repeated topics, and every write to state.json.
//
//   node denken.mjs new <slug>                  create .denken/runs/<id>/ and print its path
//   node denken.mjs start <run>                 check spec.md, snapshot the role assignment, begin plan
//   node denken.mjs confirm <run> --user-said <text>   the user approved the scope and TODO lists; begin dev
//   node denken.mjs next <run> [--wait <sec>]   advance the run; prints one JSON action
//   node denken.mjs rule <run> --decision <uphold|dismiss|replan|abort> (--note <text> | --note-file <path>)
//                   [--identities <a,b>]        which open findings a dismissal covers
//   (start, next, rule and retry take a per-run lock, so only one engine process works on a run.)
//   node denken.mjs retry <run>                 resume after a needs_user block
//   node denken.mjs status <run>                compact summary
//
// Actions printed by next: running | needs_ruling | needs_user | done | aborted.
// Run files: spec.md (DENKEN) -> todo-dev.md + todo-qa.md (METHODE) -> user confirms -> dev, qa, wiki.
// Run from the project root.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_DIR = join(dirname(SCRIPT), "..");
const ROOT = process.cwd();
const DENKEN_DIR = join(ROOT, ".denken");
const NOT_DENKEN = ":(exclude).denken";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NEXT_STAGE = { plan: "dev", dev: "qa", qa: "wiki", wiki: "done" };
const WORKER = { plan: "methode", dev: "stark", wiki: "serie" };
const REVIEWER = { plan: "richter", dev: "ubel", wiki: "frieren" };
const SPEC = "spec.md";
const TODO_DEV = "todo-dev.md";
const TODO_QA = "todo-qa.md";
const ARTIFACTS = { plan: [TODO_DEV, TODO_QA], dev: ["dev-report.md"], wiki: ["wiki-report.md"] };
const USAGE_LIMIT = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/i;

// ---------- helpers

const print = (value) => console.log(JSON.stringify(value, null, 2));
function fail(message) {
  print({ action: "error", error: message });
  process.exit(1);
}
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hashFile = (path) => {
  try {
    return sha(readFileSync(path));
  } catch {
    return "missing";
  }
};
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(...args) {
  const r = spawnSync("git", args, { cwd: ROOT, maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : Buffer.alloc(0);
}
const gitText = (...args) => git(...args).toString("utf8").trim();

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// ---------- state

function runDirOf(arg) {
  if (!arg) fail("missing <run> argument");
  const dir = resolve(ROOT, arg);
  if (!existsSync(join(dir, "state.json"))) fail(`not a run directory: ${arg}`);
  return dir;
}
function load(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch (e) {
    fail(`${join(dir, "state.json")} is unreadable: ${e.message}`);
  }
}
function save(dir, state) {
  const tmp = join(dir, "state.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, join(dir, "state.json"));
}
const callBase = (dir, id) => join(dir, "calls", id);

// ---------- file guard

function snapshot(runDir, callId) {
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z", "--", ".", NOT_DENKEN).toString().split("\0").filter(Boolean);
  const project = sha(
    Buffer.concat([
      git("rev-parse", "-q", "--verify", "HEAD"),
      git("status", "--porcelain=v1", "--untracked-files=all", "--", ".", NOT_DENKEN),
      git("diff", "--binary", "--", ".", NOT_DENKEN),
      git("diff", "--cached", "--binary", "--", ".", NOT_DENKEN),
      ...untracked.map((f) => Buffer.from(`${f}\0${hashFile(join(ROOT, f))}\n`)),
    ]),
  );
  // Ignored files such as .env: hash the ones that exist, skip ignored directories (caches, builds).
  const ignored = {};
  for (const f of git("ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", ".", NOT_DENKEN).toString().split("\0")) {
    if (f && !f.endsWith("/")) ignored[f] = hashFile(join(ROOT, f));
  }
  // Files DENKEN owns: config, and everything in the run directory except this call's own files.
  const owned = {};
  for (const name of ["config.json", "config.local.json"]) {
    const p = join(DENKEN_DIR, name);
    if (existsSync(p)) owned[relative(ROOT, p)] = hashFile(p);
  }
  for (const p of listFiles(runDir)) {
    if (!relative(runDir, p).startsWith(`calls/${callId}.`)) owned[relative(ROOT, p)] = hashFile(p);
  }
  return { project, ignored, owned };
}

// DENKEN's own files are restored from `pinned` when a call changes them. Project files are
// only reported: they belong to the user, who decides what to keep.
function violations(before, after, guard, runDir, pinned) {
  const found = [];
  if (guard.frozen && before.project !== after.project) found.push("project files changed (inspect with git status and git diff)");
  // QA runs tests, which often rewrite ignored reports (coverage.xml and the like), so QA is
  // held only to env files. Reviewers and the planner run nothing and are held to all of them.
  const watched = guard.ignored === "all" ? () => true : guard.ignored === "env" ? (f) => /(^|\/)\.env/.test(f) : () => false;
  for (const [f, h] of Object.entries(before.ignored)) {
    if (watched(f) && hashFile(join(ROOT, f)) !== h) found.push(`ignored file changed: ${f}`);
  }
  const allowed = new Set(guard.allow.map((f) => relative(ROOT, join(runDir, f))));
  for (const f of new Set([...Object.keys(before.owned), ...Object.keys(after.owned)])) {
    if (before.owned[f] === after.owned[f] || allowed.has(f)) continue;
    const path = join(ROOT, f);
    if (f in pinned) writeFileSync(path, pinned[f]);
    else if (!(f in before.owned)) rmSync(path, { force: true });
    found.push(`DENKEN file changed: ${f}${f in pinned || !(f in before.owned) ? " (restored)" : ""}`);
  }
  return found;
}

function pinOwned(owned) {
  const pinned = {};
  for (const f of Object.keys(owned)) if (!f.endsWith(".log")) pinned[f] = readFileSync(join(ROOT, f));
  return pinned;
}

// ---------- spec and TODO lists
// spec.md (DENKEN) lists in-scope items "- S<n>. ... Done when: ..." and out-of-scope items
// "- X<n>. ...". METHODE's todo-dev.md lists "- [ ] D<n> (S..) ..." items plus an Acceptance
// section (each S item's "Done when") and a Do not build section (the X items), so STARK can
// work from that one file. todo-qa.md lists "- [ ] Q<n> (S..|X..) ..." items. The engine checks
// the lists against the spec before a reviewer sees them, and the QA report against todo-qa.md.

const readRunFile = (runDir, name) => (existsSync(join(runDir, name)) ? readFileSync(join(runDir, name), "utf8") : "");

function section(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(l.trim()));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

// Items "- S1. ..." in a section, each with the text of its line and any continuation lines.
function sectionItems(body, letter) {
  const items = [];
  for (const line of (body ?? "").split("\n")) {
    const m = line.match(new RegExp(`^\\s*[-*]\\s*[*_\`]*${letter}(\\d+)\\b`));
    if (m) items.push({ id: Number(m[1]), text: line });
    else if (items.length && line.trim() && !/^\s*[-*]\s/.test(line.slice(0, 2))) items.at(-1).text += `\n${line}`;
  }
  return items;
}

function parseSpec(text) {
  const inScope = section(text, "In scope");
  const outOfScope = section(text, "Out of scope");
  const sItems = sectionItems(inScope, "S");
  const xItems = sectionItems(outOfScope, "X");
  return { hasIn: inScope !== null, hasOut: outOfScope !== null, sItems, xItems, inScope: sItems.map((i) => i.id), outOfScope: xItems.map((i) => i.id) };
}

// TODO items live in one section (todo-dev.md "## TODO", todo-qa.md "## Checks") as checkbox
// lines. Tolerates the formatting models add: "- [ ] **D1** (S1) ...", "- [x] `D1`: (S1) ...".
// A D/Q-looking line there without a checkbox, a duplicate id, or a missing section is reported,
// never silently skipped: STARK reads the whole file, so an unparsed item would escape the checks.
const ITEM_SECTION = { D: "TODO", Q: "Checks" };

function parseTodos(text, letter) {
  const body = section(text, ITEM_SECTION[letter]);
  const items = [];
  const problems = [];
  if (body === null) problems.push({ key: "section", problem: `the "## ${ITEM_SECTION[letter]}" section is missing` });
  for (const line of (body ?? "").split("\n")) {
    const m = line.match(new RegExp(`^\\s*[-*]\\s*\\[([ xX])\\]\\s*[*_\`]*${letter}(\\d+)\\b[*_\`]*\\s*[:.]?\\s*(?:\\(([^)]*)\\))?(.*)$`));
    if (!m) {
      const loose = line.match(new RegExp(`^\\s*[-*]\\s*[*_\`]*${letter}(\\d+)\\b`));
      if (loose) problems.push({ key: `${letter}${loose[1]}`, problem: `${letter}${loose[1]} is not a checkbox line ("- [ ] ${letter}${loose[1]} ...")` });
      continue;
    }
    const id = Number(m[2]);
    if (items.some((i) => i.id === id)) {
      problems.push({ key: `${letter}${id}`, problem: `${letter}${id} appears more than once` });
      continue;
    }
    items.push({ id, done: m[1] !== " ", refs: (m[3] ?? "").match(/[SX]\d+/g) ?? [], text: m[4].trim() });
  }
  return { items, problems };
}

// Bullet lines under "## Open questions" in todo-dev.md, other than "None".
function openQuestions(runDir) {
  return (section(readRunFile(runDir, TODO_DEV), "Open questions") ?? "")
    .split("\n")
    .filter((l) => /^\s*[-*]\s+\S/.test(l) && !/^\s*[-*]\s+(none|n\/a)\b/i.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
}

function specProblems(text) {
  const spec = parseSpec(text);
  const problems = [];
  if (!spec.hasIn || spec.inScope.length === 0) problems.push('spec.md needs an "## In scope" section with items "- S1. ... Done when: ..."');
  for (const item of spec.sItems) if (!/done when/i.test(item.text)) problems.push(`S${item.id} needs a "Done when:" condition someone could check`);
  if (!spec.hasOut) problems.push('spec.md needs an "## Out of scope" section (items "- X1. ...", or "- None")');
  const unclear = [...text.matchAll(/\[NEEDS CLARIFICATION:([^\]]*)\]/gi)].map((m) => m[1].trim());
  if (unclear.length) problems.push(`spec.md still has open questions for the user: ${unclear.join("; ")}`);
  return problems;
}

// The TODO lists as confirmed: checkbox state is ignored, so STARK ticking items off is not a change.
function confirmedHashes(runDir) {
  const untick = (text) => text.replace(/^(\s*[-*]\s*)\[[xX]\]/gm, "$1[ ]");
  return { spec: sha(readRunFile(runDir, SPEC)), todoDev: sha(untick(readRunFile(runDir, TODO_DEV))), todoQa: sha(untick(readRunFile(runDir, TODO_QA))) };
}

// Coverage gaps, each with its own identity so one gap cannot hide or dismiss another.
function todoGaps(runDir) {
  const spec = parseSpec(readRunFile(runDir, SPEC));
  const devText = readRunFile(runDir, TODO_DEV);
  const devParse = parseTodos(devText, "D");
  const qaParse = parseTodos(readRunFile(runDir, TODO_QA), "Q");
  const dev = devParse.items;
  const qa = qaParse.items;
  const gaps = [];
  const gap = (identity, file, spec_item, todo, problem, required_change) =>
    gaps.push({ identity, severity: "blocking", topic: identity, file, line_start: null, line_end: null, spec_item, todo, problem, required_change, source: "engine" });
  const known = (ref) => (ref[0] === "S" ? spec.inScope : spec.outOfScope).includes(Number(ref.slice(1)));

  if (!dev.length) gap("todo-dev-empty", TODO_DEV, null, null, "todo-dev.md has no D items", 'Write the development TODO under "## TODO" as "- [ ] D1 (S1) ..." items.');
  if (!qa.length) gap("todo-qa-empty", TODO_QA, null, null, "todo-qa.md has no Q items", 'Write the QA TODO under "## Checks" as "- [ ] Q1 (S1) ..." items.');
  for (const [file, parsed] of [[TODO_DEV, devParse], [TODO_QA, qaParse]]) {
    for (const p of parsed.problems) gap(`todo-format-${p.key}`, file, null, p.key === "section" ? null : p.key, `${file}: ${p.problem}`, "Fix the list format: one checkbox line per item, each id once, inside its section.");
  }
  // STARK's contract is the copied text itself, so the copies must match the spec. Only
  // whitespace, the bullet, emphasis and case may differ.
  const contract = (text) => text.replace(/^\s*[-*]\s*/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const copies = (heading, letter) => new Map(sectionItems(section(devText, heading), letter).map((i) => [i.id, contract(i.text)]));
  const acceptance = copies("Acceptance", "S");
  const doNotBuild = copies("Do not build", "X");
  for (const item of spec.sItems) {
    const n = item.id;
    if (dev.length && !dev.some((d) => d.refs.includes(`S${n}`))) gap(`spec-${n}`, TODO_DEV, n, null, `S${n} has no development TODO`, `Add a D item that implements S${n}.`);
    if (qa.length && !qa.some((q) => q.refs.includes(`S${n}`))) gap(`spec-${n}`, TODO_QA, n, null, `S${n} has no QA TODO`, `Add a Q item that verifies S${n}.`);
    if (!acceptance.has(n)) gap(`todo-acceptance-S${n}`, TODO_DEV, n, null, `S${n} is missing from the Acceptance section of todo-dev.md`, `Copy S${n} and its "Done when" from spec.md into "## Acceptance".`);
    else if (acceptance.get(n) !== contract(item.text)) gap(`todo-acceptance-S${n}`, TODO_DEV, n, null, `S${n} in the Acceptance section of todo-dev.md differs from spec.md`, `Copy S${n} from spec.md word for word.`);
  }
  for (const item of spec.xItems) {
    const n = item.id;
    if (!doNotBuild.has(n)) gap(`todo-do-not-build-X${n}`, TODO_DEV, null, null, `X${n} is missing from the Do not build section of todo-dev.md`, `Copy X${n} from spec.md into "## Do not build".`);
    else if (doNotBuild.get(n) !== contract(item.text)) gap(`todo-do-not-build-X${n}`, TODO_DEV, null, null, `X${n} in the Do not build section of todo-dev.md differs from spec.md`, `Copy X${n} from spec.md word for word.`);
  }
  for (const d of dev) {
    if (!d.refs.some((r) => r[0] === "S")) gap(`todo-D${d.id}`, TODO_DEV, null, `D${d.id}`, `D${d.id} does not name the spec item it implements`, `Add the S item(s) in parentheses after D${d.id}.`);
    for (const r of d.refs) {
      if (r[0] === "X") gap(`todo-D${d.id}`, TODO_DEV, null, `D${d.id}`, `D${d.id} implements ${r}, which the spec puts out of scope`, `Remove D${d.id} or the work for ${r}.`);
      else if (!known(r)) gap(`todo-D${d.id}`, TODO_DEV, null, `D${d.id}`, `D${d.id} refers to ${r}, which the spec does not define`, "Refer only to S items in spec.md.");
    }
  }
  for (const q of qa) {
    if (!q.refs.length) gap(`todo-Q${q.id}`, TODO_QA, null, `Q${q.id}`, `Q${q.id} does not name the spec item it verifies`, `Add the S or X item in parentheses after Q${q.id}.`);
    for (const r of q.refs) if (!known(r)) gap(`todo-Q${q.id}`, TODO_QA, null, `Q${q.id}`, `Q${q.id} refers to ${r}, which the spec does not define`, "Refer only to S and X items in spec.md.");
  }
  return gaps;
}

// ---------- prompts

function knownTopics(state, stage) {
  const seen = new Map();
  for (const f of state.findings[stage] ?? []) seen.set(f.identity, { identity: f.identity, topic: f.topic, file: f.file, spec_item: f.spec_item, raised: state.counts[stage]?.[f.identity] ?? 0 });
  return [...seen.values()];
}

function buildCall(runDir, state, call) {
  const p = (f) => join(runDir, f);
  const read = [];
  const write = [];
  const frozen = call.mode !== "work" || call.stage === "plan";
  const guard = { frozen, ignored: call.mode === "qa" ? "env" : frozen ? "all" : "none", allow: [] };
  const extra = [];
  const lastReview = state.lastReview[call.stage];

  // Who reads what is deliberate: STARK builds from the development TODO alone, GENAU tests
  // from the spec and the QA TODO, and every reviewer judges against the spec.
  if (call.mode === "work") {
    if (call.stage === "plan") read.push(p(SPEC));
    if (call.stage === "dev") read.push(p(TODO_DEV));
    if (call.stage === "wiki") read.push(p(SPEC), p(TODO_DEV), p("dev-report.md"), state.lastQa);
    if (call.stage === "dev" && state.devInput === "qa") read.push(state.lastQaFailures);
    else if (call.round > 1 && lastReview) read.push(lastReview);
    write.push(...ARTIFACTS[call.stage].map(p));
    guard.allow.push(...ARTIFACTS[call.stage]);
    if (call.stage === "plan") extra.push(`Do not change any project file. Write only ${TODO_DEV} and ${TODO_QA}.`);
    if (call.stage === "dev") extra.push(`Do not edit ${TODO_DEV}; report each D item's status in dev-report.md.`);
  } else if (call.mode === "review") {
    read.push(p(SPEC));
    if (call.stage === "dev") read.push(p(TODO_DEV));
    read.push(...ARTIFACTS[call.stage].map(p));
    if (call.stage !== "plan") {
      const diffPath = `${callBase(runDir, call.id)}.diff`;
      const base = state.stageBase[call.stage] || EMPTY_TREE;
      writeFileSync(diffPath, Buffer.concat([git("diff", base, "--", ".", NOT_DENKEN), Buffer.from("\n# Untracked files (read them directly)\n"), git("ls-files", "--others", "--exclude-standard", "--", ".", NOT_DENKEN)]));
      read.push(diffPath);
    }
    if (lastReview) read.push(lastReview);
    if (call.stage === "dev" && state.devInput === "qa") {
      read.push(state.lastQaFailures);
      extra.push("This round fixes failed QA checks (listed in the failures file). Check that each fix is general: no special-casing of the reported inputs, no hard-coded expected outputs, no weakened or deleted tests.");
    }
    const topics = knownTopics(state, call.stage);
    if (topics.length) extra.push(`Known topics in this stage. For the same issue, reuse the same topic, file and spec_item:\n${topics.map((t) => `  - ${t.identity} (topic "${t.topic}", file ${t.file ?? "none"}, spec_item ${t.spec_item ?? "none"}, raised ${t.raised}x)`).join("\n")}`);
    const dismissed = state.dismissed[call.stage] ?? [];
    if (dismissed.length) extra.push(`Dismissed by DENKEN. Do not raise these again: ${dismissed.join(", ")}`);
    const denials = state.lastWork[call.stage]?.denials ?? [];
    if (denials.length) extra.push(`The worker had ${denials.length} action(s) blocked by permissions in its last call. Check that nothing the work depends on was skipped:\n${denials.map((d) => `  - ${d.tool}: ${JSON.stringify(d.input).slice(0, 200)}`).join("\n")}`);
  } else {
    read.push(p(SPEC), p(TODO_QA));
  }
  if (existsSync(p("rulings.md"))) read.push(p("rulings.md"));

  const agent = agentFor(state, call);
  // A reviewer's prompt is its stage checklist followed by the rules every reviewer shares.
  const roleFile = (name) => readFileSync(join(SKILL_DIR, "roles", `${name}.md`), "utf8").trimEnd();
  const roleText = call.mode === "review" ? `${roleFile(call.role)}\n\n${roleFile("reviewer")}` : roleFile(call.role);
  const lines = [
    roleText.trimEnd(),
    "",
    "---",
    "",
    "## This call",
    "",
    `- Stage: ${call.stage}, round ${call.round}. You run on ${agent.provider}${agent.model ? ` (${agent.model})` : ""}.`,
    `- Project root: ${ROOT}`,
    `- Run directory: ${runDir}`,
    `- Read:\n${read.map((f) => `  - ${f}`).join("\n")}`,
  ];
  if (write.length) lines.push(`- Write:\n${write.map((f) => `  - ${f}`).join("\n")}`);
  for (const e of extra) lines.push(`- ${e}`);
  if (call.mode !== "work") lines.push("- Your final message must be JSON that matches the provided schema.");
  return { prompt: `${lines.join("\n")}\n`, guard, agent };
}

function agentFor(state, call) {
  const s = state.assignment.stages[call.stage];
  return call.mode === "qa" ? s.runner : call.mode === "work" ? s.worker : s.reviewer;
}

// ---------- launching and executing calls

function nextCall(state) {
  if (state.retryCall) {
    const c = state.retryCall;
    state.retryCall = null;
    return c;
  }
  const stage = state.stage;
  if (stage === "qa") return { stage, role: "genau", mode: "qa", round: ++state.round.qa, attempt: 1 };
  if (state.pending === "work") return { stage, role: WORKER[stage], mode: "work", round: ++state.round[stage], attempt: 1 };
  return { stage, role: REVIEWER[stage], mode: "review", round: state.round[stage], attempt: 1 };
}

function launch(runDir, state) {
  const call = nextCall(state);
  call.id = `${call.stage}-${call.role}-${call.round}`;
  call.nonce = randomUUID();
  const base = callBase(runDir, call.id);
  const { prompt, guard, agent } = buildCall(runDir, state, call);
  // Keep an earlier attempt's files for debugging, out of the way of the new attempt.
  const stamp = Date.now();
  for (const suffix of [".meta.json", ".pid", ".cli.pid", ".heartbeat", ".out.json", ".out.md", ".log"]) {
    if (existsSync(base + suffix)) renameSync(base + suffix, `${base}.prev-${stamp}${suffix}`);
  }
  writeFileSync(`${base}.prompt.md`, prompt);
  const timeoutMs = Math.round(state.assignment.limits.callTimeoutMin * 60000);
  writeFileSync(`${base}.job.json`, JSON.stringify({ ...call, agent, guard, timeoutMs }, null, 2));
  state.inflight = { ...call, provider: agent.provider, started: now() };
  state.calls.push({ id: call.id, mode: call.mode, provider: agent.provider, model: agent.model, attempt: call.attempt, started: state.inflight.started });
  save(runDir, state);
  const child = spawn(process.execPath, [SCRIPT, "_exec", runDir, call.id], { cwd: ROOT, detached: true, stdio: "ignore" });
  writeFileSync(`${base}.pid`, String(child.pid));
  child.unref();
}

function validOutput(mode, value) {
  if (mode === "review") {
    return ["APPROVED", "CHANGES_REQUESTED"].includes(value?.verdict) && Array.isArray(value.findings) &&
      value.findings.every((f) => ["blocking", "nonblocking"].includes(f.severity) && typeof f.topic === "string" && typeof f.problem === "string");
  }
  return ["PASS", "FAIL"].includes(value?.result) && Array.isArray(value.items) && value.items.length > 0 && value.items.every((c) => Number.isInteger(c.id) && ["PASS", "FAIL"].includes(c.result));
}

// ---------- process groups
// Each agent CLI leads its own process group, so the test runners, servers and shells it
// starts can be stopped with it. Signals go to the whole group (negative pid).

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

async function stopGroup(pgid) {
  if (!pgid || !signalGroup(pgid, 0)) return;
  signalGroup(pgid, "SIGTERM");
  for (let i = 0; i < 30 && signalGroup(pgid, 0); i++) await sleep(100);
  signalGroup(pgid, "SIGKILL");
}

// Stop a group only if its leader is still the agent CLI we started, never a reused pid.
async function stopCallGroup(base, provider) {
  const pgid = Number(existsSync(`${base}.cli.pid`) ? readFileSync(`${base}.cli.pid`, "utf8") : 0);
  if (!pgid) return;
  const command = spawnSync("ps", ["-o", "command=", "-p", String(pgid)], { encoding: "utf8" }).stdout ?? "";
  if (command.includes(provider)) await stopGroup(pgid);
}

async function runCli(provider, args, input, base, timeoutMs) {
  const logFd = openSync(`${base}.log`, "w");
  const child = spawn(provider, args, { cwd: ROOT, stdio: ["pipe", logFd, logFd], detached: true });
  closeSync(logFd);
  if (child.pid) writeFileSync(`${base}.cli.pid`, String(child.pid));
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopGroup(child.pid);
  }, timeoutMs);
  const result = await new Promise((done) => {
    child.on("error", (error) => done({ status: null, error }));
    child.on("exit", (status, signal) => done({ status, signal }));
  });
  clearTimeout(timer);
  await stopGroup(child.pid);
  return { ...result, timedOut };
}

async function execCall(runDir, id) {
  const base = callBase(runDir, id);
  // A heartbeat lets `next` tell a live call from a dead one even if the pid is reused.
  const beat = () => writeFileSync(`${base}.heartbeat`, now());
  beat();
  const heartbeat = setInterval(beat, 5000);
  const job = JSON.parse(readFileSync(`${base}.job.json`, "utf8"));
  const prompt = readFileSync(`${base}.prompt.md`, "utf8");
  const structured = job.mode !== "work";
  const schemaPath = join(SKILL_DIR, "schemas", `${job.mode}.schema.json`);
  const outPath = `${base}.out.${structured ? "json" : "md"}`;
  const { provider, model, effort, network } = job.agent;
  const meta = { status: "ok", nonce: job.nonce, exitCode: null, sessionId: null, denials: [], violations: [], error: null };
  let errorText = "";

  // Both CLIs stream JSON events; they go straight to the log so `status` can show progress.
  let args;
  if (provider === "claude") {
    meta.sessionId = randomUUID();
    args = ["-p", "--output-format", "stream-json", "--verbose", "--session-id", meta.sessionId];
    if (job.mode === "review") args.push("--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--strict-mcp-config");
    else {
      const sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };
      args.push("--permission-mode", "auto");
      if (!network) {
        // The strict allowlist covers sandboxed commands only; web tools and MCP servers
        // reach the network in-process, so they are removed too.
        sandbox.network = { strictAllowlist: true, allowedDomains: [] };
        args.push("--disallowedTools", "WebFetch,WebSearch", "--strict-mcp-config");
      }
      args.push("--settings", JSON.stringify({ sandbox }));
    }
    if (structured) args.push("--json-schema", readFileSync(schemaPath, "utf8"));
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
  } else {
    args = ["exec", "--json", "-s", job.mode === "review" ? "read-only" : "workspace-write", "-o", outPath];
    if (network && job.mode !== "review") args.push("-c", "sandbox_workspace_write.network_access=true");
    if (structured) args.push("--output-schema", schemaPath);
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push("-");
  }

  const before = snapshot(runDir, id);
  const pinned = pinOwned(before.owned);
  const result = await runCli(provider, args, prompt, base, job.timeoutMs);

  const events = [];
  for (const line of readFileSync(`${base}.log`, "utf8").split("\n")) {
    if (!line.startsWith("{")) {
      if (line.trim()) errorText += `${line}\n`;
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  if (provider === "claude") {
    const final = events.findLast((e) => e.type === "result");
    if (final) {
      meta.denials = (final.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: d.tool_input }));
      if (final.is_error) {
        meta.error = `claude reported an error: ${final.subtype ?? ""} ${final.api_error_status ?? ""}`.trim();
        errorText += `${final.result ?? ""} ${final.api_error_status ?? ""}\n`;
      }
      const output = structured ? final.structured_output : final.result;
      if (output != null) writeFileSync(outPath, structured ? JSON.stringify(output, null, 2) : String(output));
    }
  } else {
    for (const event of events) {
      if (event.type === "thread.started") meta.sessionId = event.thread_id;
      if (event.type === "error" || event.type === "turn.failed") errorText += `${JSON.stringify(event)}\n`;
    }
  }
  meta.exitCode = result.status;
  if (result.timedOut) meta.error = `timed out after ${Math.round(job.timeoutMs / 60000)} min`;
  else if (result.error) meta.error = result.error.message;

  meta.violations = violations(before, snapshot(runDir, id), job.guard, runDir, pinned);
  const output = existsSync(outPath) ? readFileSync(outPath, "utf8").trim() : "";
  if (meta.violations.length) meta.status = "guard_violation";
  else if (result.timedOut) meta.status = "timeout";
  else if (result.status !== 0 || meta.error) {
    meta.status = USAGE_LIMIT.test(errorText) ? "usage_limit" : "failed";
    meta.error ??= `${provider} exited with ${result.status}`;
  } else if (!output) {
    meta.status = "failed";
    meta.error = "the agent produced no final message";
  } else if (structured) {
    let value = null;
    try {
      value = JSON.parse(output);
    } catch {}
    const qIds = new Set(parseTodos(readRunFile(runDir, TODO_QA), "Q").items.map((q) => q.id));
    const unknown = job.mode === "qa" && validOutput("qa", value) ? value.items.filter((c) => !qIds.has(c.id)).map((c) => `Q${c.id}`) : [];
    if (!validOutput(job.mode, value)) {
      meta.status = "invalid_output";
      meta.error = "the final message does not match the schema";
    } else if (unknown.length) {
      meta.status = "invalid_output";
      meta.error = `the QA report has items that are not in todo-qa.md: ${unknown.join(", ")}`;
    }
  }
  meta.finished = now();
  clearInterval(heartbeat);
  writeMeta(base, meta);
}

// The result file is the signal that a call finished, so it is written atomically: `next`
// must never read a half-written one.
function writeMeta(base, meta) {
  writeFileSync(`${base}.meta.json.tmp`, JSON.stringify(meta, null, 2));
  renameSync(`${base}.meta.json.tmp`, `${base}.meta.json`);
}

// ---------- ingesting results

function enterStage(state, stage) {
  state.stage = stage;
  state.pending = "work";
  if (stage === "dev" || stage === "wiki") {
    state.stageBase[stage] = gitText("stash", "create") || gitText("rev-parse", "-q", "--verify", "HEAD") || EMPTY_TREE;
  }
}

function approve(state, stage, evidence) {
  state.approved[stage] = evidence;
  if (stage === "dev") state.devInput = null;
  enterStage(state, NEXT_STAGE[stage]);
  // Development starts only after the user has confirmed the scope and both TODO lists.
  if (stage === "plan") block(state, "user", { reason: "confirm_todos", resolveWith: "confirm", stage: "plan" });
}

const fileOf = (f) => (f.file ? String(f.file).replace(/:\d+.*$/, "") : null);
const tokens = (text) => new Set(slug(text).split("-").filter(Boolean));

// A finding's identity decides what counts as "the same topic". A spec item wins; otherwise
// file plus topic, where a slightly renamed topic on the same file (token Jaccard >= 0.5)
// is merged into the known identity.
function identityOf(f, known) {
  if (f.identity) return f.identity;
  if (Number.isInteger(f.spec_item)) return `spec-${f.spec_item}`;
  const file = fileOf(f);
  const mine = tokens(f.topic);
  for (const k of known) {
    if (Number.isInteger(k.spec_item) || fileOf(k) !== file) continue;
    const theirs = tokens(k.topic);
    const shared = [...mine].filter((t) => theirs.has(t)).length;
    if (shared / (mine.size + theirs.size - shared) >= 0.5) return k.identity;
  }
  return file ? `${file}::${slug(f.topic)}` : slug(f.topic);
}

function block(state, kind, details) {
  state.blocked = { kind, since: now(), ...details };
}

function checkThresholds(state, stage) {
  const { topicRepeats, roundsPerStage } = state.assignment.limits;
  const repeated = Object.entries(state.counts[stage] ?? {}).find(([, n]) => n >= topicRepeats);
  if (repeated) {
    const [identity] = repeated;
    const occurrences = (state.findings[stage] ?? []).filter((f) => f.identity === identity);
    if ((state.ruled[stage] ?? []).includes(identity)) {
      return block(state, "user", { reason: "topic_repeated_after_ruling", resolveWith: "rule", stage, identity, occurrences });
    }
    return block(state, "ruling", { reason: "topic_repeated", stage, identity, occurrences });
  }
  const history = state.history[stage].slice(state.historyBase[stage] ?? 0);
  const last = history.slice(-3).map((h) => h.blocking);
  if (last.length === 3 && last[0] > 0 && last[2] >= last[1] && last[1] >= last[0]) {
    return block(state, "ruling", { reason: "stalled", stage, blockingPerRound: last });
  }
  if (state.round[stage] - (state.capBase[stage] ?? 0) >= roundsPerStage) {
    return block(state, "ruling", { reason: "round_cap", stage, rounds: state.round[stage] });
  }
}

function ingest(runDir, state, meta) {
  const call = state.inflight;
  state.inflight = null;
  const record = state.calls.findLast((c) => c.id === call.id);
  Object.assign(record, { status: meta.status, exitCode: meta.exitCode, sessionId: meta.sessionId, finished: meta.finished ?? now(), denials: meta.denials?.length ?? 0 });
  const base = callBase(runDir, call.id);

  if (meta.status === "guard_violation") return block(state, "user", { reason: "guard_violation", resolveWith: "retry", call: call.id, violations: meta.violations });
  if (meta.status === "usage_limit") return block(state, "user", { reason: "usage_limit", resolveWith: "retry", call: call.id, provider: call.provider, error: meta.error, log: `${base}.log` });
  if (meta.status !== "ok") {
    if (call.attempt < 2) {
      state.retryCall = { ...call, attempt: call.attempt + 1 };
      delete state.retryCall.provider;
      delete state.retryCall.started;
      return;
    }
    const reason = meta.status === "timeout" ? "call_timeout" : "call_failed";
    return block(state, "user", { reason, resolveWith: "retry", call: call.id, error: meta.error, log: `${base}.log` });
  }

  const stage = call.stage;
  if (call.mode === "work") {
    const missing = ARTIFACTS[stage].filter((f) => !existsSync(join(runDir, f)));
    if (missing.length) {
      meta.status = "failed";
      meta.error = `${missing.join(", ")} was not written`;
      state.inflight = call;
      return ingest(runDir, state, meta);
    }
    state.lastWork[stage] = { call: call.id, denials: meta.denials };
    state.pending = "review";
    // Deterministic checks run before the reviewer: TODO lists with coverage gaps go straight
    // back to METHODE as an engine round, without spending a review on them.
    if (stage === "plan") {
      const gaps = todoGaps(runDir);
      if (gaps.length) {
        const gapsPath = `${base}.gaps.json`;
        writeFileSync(gapsPath, JSON.stringify({ verdict: "CHANGES_REQUESTED", findings: gaps, checked: ["engine coverage check of the TODO lists against spec.md"] }, null, 2));
        state.lastReview.plan = gapsPath;
        recordReview(state, "plan", call, gaps);
        return;
      }
    }
    state.denialStreak[stage] = meta.denials.length ? (state.denialStreak[stage] ?? 0) + 1 : 0;
    if (state.denialStreak[stage] >= 2) {
      block(state, "user", { reason: "repeated_permission_denials", resolveWith: "retry", call: call.id, denials: meta.denials });
    }
    return;
  }

  const outPath = `${base}.out.json`;
  const output = JSON.parse(readFileSync(outPath, "utf8"));

  if (call.mode === "qa") {
    state.lastQa = outPath;
    // Every Q item must be reported; one that is missing counts as failed.
    const reported = new Map(output.items.map((c) => [c.id, c]));
    const items = [...output.items];
    for (const q of parseTodos(readRunFile(runDir, TODO_QA), "Q").items) {
      if (!reported.has(q.id)) items.push({ id: q.id, spec_item: Number(q.refs.find((r) => r[0] === "S")?.slice(1)) || null, check: q.text, result: "FAIL", evidence: "missing from the QA report", reproduce: null });
    }
    const identity = (c) => (Number.isInteger(c.spec_item) ? `spec-${c.spec_item}` : `qa-${c.id}`);
    const dismissed = new Set(state.dismissed.dev ?? []);
    const failing = items.filter((c) => c.result === "FAIL" && !dismissed.has(identity(c)));
    if (failing.length === 0) return approve(state, "qa", outPath);
    // Back to dev with only the failures: STARK sees what broke, not the QA TODO list.
    // The dev stage's diff base is kept so the next review sees every change since dev began.
    state.lastQaFailures = `${base}.failures.json`;
    writeFileSync(state.lastQaFailures, JSON.stringify(failing.map(({ id, spec_item, check, evidence, reproduce }) => ({ qa_item: `Q${id}`, spec_item, check, evidence, reproduce })), null, 2));
    state.approved.dev = null;
    state.devInput = "qa";
    state.stage = "dev";
    state.pending = "work";
    for (const c of failing) {
      const id = identity(c);
      state.counts.dev[id] = (state.counts.dev[id] ?? 0) + 1;
      state.findings.dev.push({ round: state.round.dev, call: call.id, identity: id, topic: id, file: null, spec_item: c.spec_item ?? null, problem: `QA failed Q${c.id}: ${c.check ?? ""}`, required_change: c.reproduce ?? c.evidence });
    }
    return checkThresholds(state, "dev");
  }

  // review
  state.lastReview[stage] = outPath;
  if (stage === "dev") state.devInput = "review";
  if (recordReview(state, stage, call, output.findings) === 0) approve(state, stage, outPath);
}

// Records a round's findings (a reviewer's, or the engine's coverage gaps) and returns the
// number of blocking ones. With any left, the stage goes back to its worker.
function recordReview(state, stage, call, raw) {
  const dismissed = new Set(state.dismissed[stage] ?? []);
  const findings = raw.map((f) => ({ ...f, identity: identityOf(f, state.findings[stage]) })).filter((f) => !dismissed.has(f.identity));
  const blocking = findings.filter((f) => f.severity === "blocking");
  for (const f of findings.filter((f) => f.severity === "nonblocking")) state.deferred.push({ stage, round: call.round, call: call.id, ...f });
  state.history[stage].push({ round: call.round, blocking: blocking.length });
  if (blocking.length === 0) return 0;
  state.pending = "work";
  for (const f of blocking) state.findings[stage].push({ round: call.round, call: call.id, identity: f.identity, topic: f.topic, file: f.file, spec_item: f.spec_item ?? null, todo: f.todo ?? null, source: f.source ?? "review", problem: f.problem, required_change: f.required_change });
  for (const identity of new Set(blocking.map((f) => f.identity))) state.counts[stage][identity] = (state.counts[stage][identity] ?? 0) + 1;
  checkThresholds(state, stage);
  return blocking.length;
}

// ---------- actions shown to DENKEN

function actionFor(runDir, state) {
  if (state.stage === "done") {
    return { action: "done", run: relative(ROOT, runDir), approved: state.approved, deferred: state.deferred.length, rulings: state.rulings.length, crossProvider: state.assignment.crossProvider, warnings: state.assignment.warnings, next: "Write summary.md from state.json and report to the user." };
  }
  if (state.stage === "aborted") return { action: "aborted", run: relative(ROOT, runDir), rulings: state.rulings.length };
  if (state.blocked) {
    const b = state.blocked;
    if (b.kind === "ruling") {
      return { action: "needs_ruling", ...b, artifacts: (ARTIFACTS[b.stage] ?? []).map((f) => join(runDir, f)), lastReview: state.lastReview[b.stage], next: "Decide, then run: rule <run> --decision <uphold|dismiss|replan|abort> --note <text>" };
    }
    if (b.reason === "confirm_todos" || b.reason === "scope_changed") {
      const questions = openQuestions(runDir);
      const next = questions.length
        ? "METHODE left open questions. Ask the user, record the answers under Decisions in spec.md, then run rule --decision replan --note '<the answers>'."
        : "Show the user the scope (spec.md) and both TODO lists. If they approve, run confirm --user-said '<their approval, verbatim>'. If they want changes, edit spec.md first when the scope itself changes, then run rule --decision replan --note '<their changes>'.";
      return { action: "needs_user", ...b, files: [SPEC, TODO_DEV, TODO_QA].map((f) => join(runDir, f)), openQuestions: questions, next };
    }
    return { action: "needs_user", ...b, next: b.resolveWith === "rule" ? "Ask the user, then record their decision with rule." : "Tell the user. When it is resolved, run retry (or rule --decision abort)." };
  }
  const c = state.inflight;
  if (c) return { action: "running", call: c.id, provider: c.provider, stage: c.stage, round: c.round, elapsedSec: Math.round((Date.now() - Date.parse(c.started)) / 1000), next: "Run next again with --wait." };
  return null;
}

async function next(runDir, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const state = load(runDir);
    if (state.stage === "intake") fail("the run has not started; write spec.md, confirm it with the user, then run start");
    if (["done", "aborted"].includes(state.stage) || state.blocked) return print(actionFor(runDir, state));
    if (state.inflight) {
      // Wait on the call's own files only. state.json is not re-read until the call has
      // finished, because a misbehaving call may have it in a broken state until it is restored.
      const base = callBase(runDir, state.inflight.id);
      const pid = Number(existsSync(`${base}.pid`) ? readFileSync(`${base}.pid`, "utf8") : 0);
      const alive = () => {
        if (!pid || !pidAlive(pid)) return false;
        const age = Date.now() - Date.parse(state.inflight.started);
        return existsSync(`${base}.heartbeat`) ? Date.now() - statSync(`${base}.heartbeat`).mtimeMs < 60000 : age < 30000;
      };
      // Only this attempt's result counts. A result from an earlier attempt of the same call
      // (one judged dead that finished anyway) is set aside, not ingested.
      const readMeta = () => {
        if (!existsSync(`${base}.meta.json`)) return null;
        const meta = JSON.parse(readFileSync(`${base}.meta.json`, "utf8"));
        if (!state.inflight.nonce || meta.nonce === state.inflight.nonce) return meta;
        renameSync(`${base}.meta.json`, `${base}.stale-${Date.now()}.meta.json`);
        return null;
      };
      let meta = readMeta();
      while (!meta && alive() && Date.now() < deadline) {
        // Poll quickly at first, then back off to every 3 seconds for long calls.
        const age = Date.now() - Date.parse(state.inflight.started);
        await sleep(Math.min(Math.max(200, age / 10), 3000, Math.max(0, deadline - Date.now())));
        meta = readMeta();
      }
      if (!meta) {
        if (alive()) return print(actionFor(runDir, state));
        // The call's process died. Stop whatever its agent CLI left running before moving on.
        await stopCallGroup(base, state.inflight.provider);
        meta = { status: "failed", error: "the call process exited without writing a result", finished: now() };
      }
      assertLock();
      ingest(runDir, state, meta);
      save(runDir, state);
      continue;
    }
    // The user confirmed specific content. If spec.md or a TODO list changed since, stop:
    // development must not run against something the user did not approve.
    if (state.confirmed && ["dev", "qa", "wiki"].includes(state.stage)) {
      const current = confirmedHashes(runDir);
      const changed = Object.keys(current).filter((k) => current[k] !== state.confirmed.hashes[k]);
      if (changed.length) {
        block(state, "user", { reason: "scope_changed", resolveWith: "confirm", stage: "plan", changed });
        assertLock();
        save(runDir, state);
        continue;
      }
    }
    assertLock();
    launch(runDir, state);
    if (Date.now() >= deadline) return print(actionFor(runDir, load(runDir)));
  }
}

// ---------- commands

function cmdNew(name) {
  if (!name) fail("usage: new <slug>");
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = join(DENKEN_DIR, "runs", `${stamp}-${slug(name)}`);
  if (existsSync(dir)) fail(`run already exists: ${relative(ROOT, dir)}`);
  mkdirSync(join(dir, "calls"), { recursive: true });
  const ignore = join(DENKEN_DIR, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "runs/\nlocks/\nconfig.local.json\n");
  save(dir, { version: 1, task: name, created: now(), stage: "intake" });
  print({ action: "created", run: relative(ROOT, dir), next: `Write ${relative(ROOT, join(dir, SPEC))}, confirm it with the user, then run start.` });
}

function cmdStart(runDir) {
  const state = load(runDir);
  if (state.stage !== "intake") fail(`run already started (stage: ${state.stage})`);
  const problems = specProblems(readRunFile(runDir, SPEC));
  if (problems.length) fail(problems.join("; "));
  if (spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT }).status !== 0) fail("DENKEN needs a git work tree to detect file changes; run git init first");
  const config = resolveConfig(ROOT);
  if (config.errors.length) {
    print({ action: "needs_user", reason: "config", errors: config.errors, warnings: config.warnings, next: "Fix the configuration with config.mjs, then run start again." });
    process.exit(1);
  }
  if (config.sameReviewer.length && !config.allowSameReviewer) {
    print({ action: "needs_user", reason: "same_reviewer", stages: config.sameReviewer, next: "The same model would check its own work. Ask the user: set a different reviewer (richter, ubel, frieren) or genau model or effort with config.mjs, or set allowSameReviewer true. Then run start again." });
    process.exit(1);
  }
  Object.assign(state, {
    assignment: { crossProvider: config.crossProvider, sameReviewer: config.sameReviewer, stages: config.stages, limits: config.limits, warnings: config.warnings },
    baseRef: gitText("rev-parse", "-q", "--verify", "HEAD") || null,
    round: { plan: 0, dev: 0, qa: 0, wiki: 0 },
    stageBase: {},
    counts: { plan: {}, dev: {}, wiki: {} },
    findings: { plan: [], dev: [], wiki: [] },
    history: { plan: [], dev: [], wiki: [] },
    historyBase: {},
    capBase: {},
    dismissed: {},
    ruled: {},
    denialStreak: {},
    lastReview: {},
    lastWork: {},
    lastQa: null,
    lastQaFailures: null,
    devInput: null,
    deferred: [],
    rulings: [],
    approved: { plan: null, dev: null, qa: null, wiki: null },
    calls: [],
    inflight: null,
    blocked: null,
    retryCall: null,
  });
  enterStage(state, "plan");
  assertLock();
  save(runDir, state);
  print({ action: "started", run: relative(ROOT, runDir), crossProvider: config.crossProvider, stages: config.stages, limits: config.limits, warnings: config.warnings, next: "Run next with --wait." });
}

function cmdRule(runDir, args) {
  const state = load(runDir);
  if (!state.blocked) fail("nothing to rule on: the run is not blocked");
  const decision = args[args.indexOf("--decision") + 1];
  if (!["uphold", "dismiss", "replan", "abort"].includes(decision)) fail("--decision must be uphold, dismiss, replan or abort");
  const noteIndex = args.indexOf("--note");
  const fileIndex = args.indexOf("--note-file");
  const note = noteIndex >= 0 ? args[noteIndex + 1] : fileIndex >= 0 ? readFileSync(args[fileIndex + 1], "utf8") : null;
  if (!note?.trim()) fail("a ruling needs --note <text> or --note-file <path> explaining the decision and the direction");

  const b = state.blocked;
  const stage = b.stage ?? state.stage;
  if (["confirm_todos", "scope_changed"].includes(b.reason) && !["replan", "abort"].includes(decision)) {
    fail("at the TODO confirmation, use confirm when the user approves, or rule --decision replan|abort");
  }
  if (decision === "replan") {
    const problems = specProblems(readRunFile(runDir, SPEC));
    if (problems.length) fail(`fix spec.md before replanning: ${problems.join("; ")}`);
  }
  // Dismissals are per finding: a stage-wide ruling must name each identity it dismisses.
  const open = new Set(state.findings[stage]?.filter((f) => f.round === state.round[stage]).map((f) => f.identity));
  const listIndex = args.indexOf("--identities");
  const listed = listIndex >= 0 ? String(args[listIndex + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const targets = [...new Set([...(b.identity ? [b.identity] : []), ...listed])];
  if (decision === "dismiss") {
    if (targets.length === 0) fail(`name the findings to dismiss with --identities <a,b>. Open: ${[...open].join(", ") || "none"}`);
    const unknown = targets.filter((t) => t !== b.identity && !open.has(t));
    if (unknown.length) fail(`not open in this stage: ${unknown.join(", ")}. Open: ${[...open].join(", ")}`);
  }
  const id = `R${state.rulings.length + 1}`;
  const subject = decision === "dismiss" ? targets.join(", ") : b.identity ?? b.reason;
  assertLock();
  state.rulings.push({ id, stage, subject, reason: b.reason, decision, at: now() });
  appendFileSync(join(runDir, "rulings.md"), `${state.rulings.length === 1 ? "# Rulings\n\n" : ""}## ${id} · ${stage} · ${subject} · ${decision}\n\n${note.trim()}\n\n`);
  state.blocked = null;
  state.capBase[stage] = state.round[stage];
  state.historyBase[stage] = state.history[stage]?.length ?? 0;
  if (b.identity) {
    state.counts[stage][b.identity] = 0;
    (state.ruled[stage] ??= []).push(b.identity);
  }

  if (decision === "abort") state.stage = "aborted";
  else if (decision === "replan") {
    for (const s of ["plan", "dev", "qa", "wiki"]) state.approved[s] = null;
    state.devInput = null;
    state.confirmed = null;
    enterStage(state, "plan");
  } else if (decision === "dismiss") {
    (state.dismissed[stage] ??= []).push(...targets);
    for (const t of targets) state.counts[stage][t] = 0;
    // Approve only when nothing blocking remains open after the dismissal. The dismissed
    // findings are kept, marked as such, for the summary.
    const dismissed = new Set(state.dismissed[stage]);
    const lastRound = state.findings[stage].filter((f) => f.round === state.round[stage]);
    if (lastRound.every((f) => dismissed.has(f.identity)) && state.lastReview[stage]) {
      for (const f of lastRound) state.deferred.push({ stage, round: f.round, call: f.call, ...f, severity: "dismissed" });
      approve(state, stage, `${state.lastReview[stage]} + ruling ${id}`);
    }
  }
  assertLock();
  save(runDir, state);
  print({ action: "ruled", id, decision, stage: state.stage, next: state.stage === "aborted" ? "Tell the user the run was aborted." : "Run next with --wait." });
}

function cmdRetry(runDir) {
  const state = load(runDir);
  const b = state.blocked;
  if (!b || b.kind !== "user") fail("nothing to retry: the run is not waiting on the user");
  if (b.resolveWith !== "retry") fail(`this block is resolved with ${b.resolveWith}, not retry`);
  state.blocked = null;
  if (b.reason !== "repeated_permission_denials") {
    const last = state.calls.findLast((c) => c.id === b.call);
    const [stage, role, round] = b.call.split("-");
    state.retryCall = { stage, role, mode: last.mode, round: Number(round), attempt: 1 };
    if (last.mode === "work") state.pending = "work";
  } else {
    state.denialStreak[state.stage] = 0;
  }
  assertLock();
  save(runDir, state);
  print({ action: "resumed", next: "Run next with --wait." });
}

// The last thing a running call did, read from the tail of its streamed log.
function lastActivity(logPath) {
  if (!existsSync(logPath)) return null;
  const { size, mtime } = statSync(logPath);
  const length = Math.min(size, 65536);
  const buffer = Buffer.alloc(length);
  const fd = openSync(logPath, "r");
  readSync(fd, buffer, 0, length, size - length);
  closeSync(fd);
  const describe = (e) => {
    const part = e.type === "assistant" ? e.message?.content?.findLast?.((c) => c.type === "tool_use" || c.type === "text") : null;
    if (part?.type === "tool_use") return `${part.name} ${JSON.stringify(part.input)}`;
    if (part?.type === "text") return part.text;
    if (e.item?.type === "command_execution") return `command: ${e.item.command}`;
    if (e.item?.type === "agent_message") return e.item.text;
    return e.item?.type ?? null;
  };
  for (const line of buffer.toString("utf8").split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const text = describe(JSON.parse(line));
      if (text) return { updated: mtime.toISOString(), last: String(text).replace(/\s+/g, " ").slice(0, 160) };
    } catch {}
  }
  return { updated: mtime.toISOString(), last: null };
}

// One engine process per run. Claude Code moves a slow command to the background instead of
// killing it, so without a lock two `next` processes could ingest or launch the same call.
// The lock is a directory (mkdir is atomic), refreshed by a heartbeat. A lock whose heartbeat
// is older than LOCK_STALE_MS is stale no matter what its pid is, so a reused pid cannot keep
// a dead run busy. A stale lock is taken over by renaming it away, which only one process can do.
const LOCK_STALE_MS = 30000;
const lock = { dir: null, nonce: null };

function holdsLock() {
  try {
    return JSON.parse(readFileSync(join(lock.dir, "owner"), "utf8")).nonce === lock.nonce;
  } catch {
    return false;
  }
}

function assertLock() {
  if (!holdsLock()) fail("this engine process lost the run lock (another process took the run over); stopping without changing anything");
}

async function acquireLock(runDir, waitMs) {
  mkdirSync(join(DENKEN_DIR, "locks"), { recursive: true });
  const dir = join(DENKEN_DIR, "locks", `${basename(runDir)}.lock`);
  const deadline = Date.now() + waitMs;
  const nonce = randomUUID();
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid, nonce, since: now() }));
      Object.assign(lock, { dir, nonce });
      setInterval(() => {
        try {
          const t = new Date();
          utimesSync(dir, t, t);
        } catch {}
      }, 5000).unref();
      const release = () => holdsLock() && rmSync(dir, { recursive: true, force: true });
      process.on("exit", release);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => {
          release();
          process.exit(128);
        });
      }
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let stale;
    try {
      const age = Date.now() - statSync(dir).mtimeMs;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(join(dir, "owner"), "utf8"));
      } catch {}
      // No owner file yet means another process is between mkdir and writing it.
      stale = age > LOCK_STALE_MS || (owner ? !pidAlive(owner.pid) : age > 2000);
    } catch {
      continue;
    }
    if (stale) {
      const grave = `${dir}.stale-${randomUUID()}`;
      try {
        renameSync(dir, grave);
        rmSync(grave, { recursive: true, force: true });
      } catch {}
      continue;
    }
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

function cmdConfirm(runDir, args) {
  const state = load(runDir);
  if (!["confirm_todos", "scope_changed"].includes(state.blocked?.reason)) fail("nothing to confirm: the run is not waiting for TODO confirmation");
  const i = args.indexOf("--user-said");
  const userSaid = i >= 0 ? String(args[i + 1] ?? "").trim() : "";
  if (!userSaid) fail("record the user's approval: confirm <run> --user-said '<what they said, verbatim>'");
  if (state.blocked.reason === "scope_changed") {
    const current = confirmedHashes(runDir);
    const reviewed = ["spec", "todoDev"].filter((k) => current[k] !== state.confirmed.hashes[k]);
    if (reviewed.length) fail(`${reviewed.join(" and ")} changed since the user confirmed; no reviewer has checked the new content. Restore it, or run rule --decision replan.`);
  }
  const problems = [...specProblems(readRunFile(runDir, SPEC)), ...todoGaps(runDir).map((g) => g.problem)];
  if (problems.length) fail(`cannot confirm: ${problems.join("; ")}. Fix spec.md and replan.`);
  const questions = openQuestions(runDir);
  if (questions.length) fail(`cannot confirm while todo-dev.md has open questions: ${questions.join("; ")}. Ask the user, record the answers in spec.md, then replan.`);
  state.blocked = null;
  state.confirmed = { at: now(), userSaid, hashes: confirmedHashes(runDir) };
  (state.confirmations ??= []).push(state.confirmed);
  assertLock();
  save(runDir, state);
  print({ action: "confirmed", next: "Development starts. Run next with --wait." });
}

function cmdStatus(runDir) {
  const s = load(runDir);
  print({
    run: relative(ROOT, runDir),
    task: s.task,
    stage: s.stage,
    pending: s.pending,
    rounds: s.round,
    inflight: s.inflight && { call: s.inflight.id, provider: s.inflight.provider, started: s.inflight.started, activity: lastActivity(`${callBase(runDir, s.inflight.id)}.log`) },
    blocked: s.blocked && { kind: s.blocked.kind, reason: s.blocked.reason },
    approved: s.approved,
    topics: s.counts,
    deferred: s.deferred?.length ?? 0,
    rulings: s.rulings?.map((r) => `${r.id} ${r.stage} ${r.subject} ${r.decision}`),
    calls: s.calls?.slice(-6).map((c) => `${c.id} ${c.provider} ${c.status ?? "running"}`),
  });
}

const [command, runArg, ...rest] = process.argv.slice(2);
const locked = async (fn) => {
  const runDir = runDirOf(runArg);
  if (!(await acquireLock(runDir, 0))) fail("another DENKEN engine process is working on this run; wait for it, then try again");
  fn(runDir);
};
switch (command) {
  case "new":
    cmdNew(runArg);
    break;
  case "start":
    await locked(cmdStart);
    break;
  case "next": {
    const i = rest.indexOf("--wait");
    const waitSec = i >= 0 ? Number(rest[i + 1]) || 0 : 0;
    const runDir = runDirOf(runArg);
    if (!(await acquireLock(runDir, waitSec * 1000))) {
      print({ action: "running", busy: true, next: "Another DENKEN engine process is waiting on this run. Run next again with --wait." });
      break;
    }
    await next(runDir, waitSec);
    break;
  }
  case "rule":
    await locked((runDir) => cmdRule(runDir, rest));
    break;
  case "retry":
    await locked(cmdRetry);
    break;
  case "confirm":
    await locked((runDir) => cmdConfirm(runDir, rest));
    break;
  case "status":
    cmdStatus(runDirOf(runArg));
    break;
  case "_exec":
    try {
      await execCall(runArg, rest[0]);
    } catch (e) {
      const base = callBase(runArg, rest[0]);
      let nonce = null;
      try {
        nonce = JSON.parse(readFileSync(`${base}.job.json`, "utf8")).nonce;
      } catch {}
      writeMeta(base, { status: "failed", nonce, error: `runner error: ${e.message}`, finished: now() });
    }
    break;
  default:
    fail("usage: denken.mjs <new|start|next|confirm|rule|retry|status> ...");
}
