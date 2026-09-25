// The TODO lists METHODE writes, and the recovery TODO the engine writes: their items, and how they must cover the request.
import { REQUEST, sha, TODO_DEV, TODO_FIX, TODO_QA } from "./core.mjs";
import { contract, parseRequest, section, sectionItems } from "./request.mjs";
import { readRunFile } from "./state.mjs";

export const ITEM = {
  DEV: { file: TODO_DEV, heading: /^##\s+TODO\s*$/i, name: "TODO" },
  QA: { file: TODO_QA, heading: /^##\s+Checks\s*$/i, name: "Checks" },
  FIX: { file: TODO_FIX, heading: /^##\s+QA cycle\b/i, name: "QA cycle <n>" },
};

export const EVIDENCE_LINE = /^\s+Evidence:\s*(.*)$/;

export const blockedIn = (report, key) => new RegExp(`\\b${key}\\b[^\\n]*\\bblocked\\b`, "i").test(report);

export function inItemSection(lines, i, heading) {
  for (let j = i; j >= 0; j--) if (/^##\s/.test(lines[j])) return heading.test(lines[j].trim());
  return false;
}

// Items of one kind in their section: checkbox, references, text, block (with continuation lines)
// and evidence. A line there that looks like an item but is not a checkbox line, a repeated id,
// or a missing section is reported, never skipped: STARK reads the whole file, so an unparsed
// item would escape the checks. Tolerates "- [ ] **DEV-001** (REQ-001) ..." and similar.
export function parseItems(text, prefix) {
  const lines = text.split("\n");
  const items = [];
  const problems = [];
  if (!lines.some((l) => ITEM[prefix].heading.test(l.trim()))) problems.push({ key: "section", problem: `the "## ${ITEM[prefix].name}" section is missing` });
  let cycle = null;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      current = null;
      cycle = Number(line.match(/^##\s+QA cycle\s+(\d+)/i)?.[1]) || null;
      continue;
    }
    if (!inItemSection(lines, i, ITEM[prefix].heading)) continue;
    const m = line.match(new RegExp(`^\\s*[-*]\\s*\\[([ xX])\\]\\s*[*_\`]*(${prefix}-\\d{3,})\\b[*_\`]*\\s*[:.]?\\s*(?:\\(([^)]*)\\))?(.*)$`));
    if (m) {
      current = null;
      if (items.some((x) => x.key === m[2])) {
        problems.push({ key: m[2], problem: `${m[2]} appears more than once` });
        continue;
      }
      current = { key: m[2], done: m[1] !== " ", refs: (m[3] ?? "").match(/\b(?:REQ|OUT|LATER|CAUTION|QA)-\d{3,}\b/g) ?? [], text: m[4].trim(), block: line, evidence: null, cycle };
      items.push(current);
      continue;
    }
    if (current && /^\s{2,}\S/.test(line)) {
      current.block += `\n${line}`;
      const e = line.match(EVIDENCE_LINE);
      if (e && current.evidence === null) current.evidence = e[1].trim();
      continue;
    }
    const loose = line.match(new RegExp(`^[-*]\\s*[*_\`]*(${prefix}-\\d{3,})\\b`));
    if (loose) problems.push({ key: loose[1], problem: `${loose[1]} is not a checkbox line ("- [ ] ${loose[1]} ...")` });
    if (line.trim()) current = null;
  }
  return { items, problems };
}

export const fixItems = (runDir) => parseItems(readRunFile(runDir, TODO_FIX), "FIX").items;

// Bullet lines under "## Open questions" in todo-dev.md, other than "None".
export function openQuestions(runDir) {
  return (section(readRunFile(runDir, TODO_DEV), "Open questions") ?? "")
    .split("\n")
    .filter((l) => /^\s*[-*]\s+\S/.test(l) && !/^\s*[-*]\s+(none|n\/a)\b/i.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
}

// The plan as the user confirmed it: ticks and evidence lines are progress, not a change to it.
export const planText = (text) => text.split("\n").filter((l) => !EVIDENCE_LINE.test(l)).join("\n").replace(/^(\s*[-*]\s*)\[[xX]\]/gm, "$1[ ]");

export function confirmedHashes(runDir) {
  return { request: sha(readRunFile(runDir, REQUEST)), todoDev: sha(planText(readRunFile(runDir, TODO_DEV))), todoQa: sha(planText(readRunFile(runDir, TODO_QA))) };
}

// Coverage gaps, each with its own identity so one gap cannot hide or dismiss another.
export function todoGaps(runDir) {
  const req = parseRequest(readRunFile(runDir, REQUEST));
  const devText = readRunFile(runDir, TODO_DEV);
  const devParse = parseItems(devText, "DEV");
  const qaParse = parseItems(readRunFile(runDir, TODO_QA), "QA");
  const dev = devParse.items;
  const qa = qaParse.items;
  const gaps = [];
  const gap = (identity, file, request_item, todo, problem, required_change) =>
    gaps.push({ identity, severity: "blocking", topic: identity, file, line_start: null, line_end: null, request_item, todo, problem, required_change, source: "engine" });
  // A QA item may check any request item, a caution included; a DEV item builds REQ items and may
  // name the cautions it keeps.
  const known = new Set([...req.REQ.items, ...req.OUT.items, ...req.LATER.items, ...req.CAUTION.items].map((i) => i.key));

  if (!dev.length) gap("todo-dev-empty", TODO_DEV, null, null, "todo-dev.md has no DEV items", 'Write the development TODO under "## TODO" as "- [ ] DEV-001 (REQ-001) ..." items.');
  if (!qa.length) gap("todo-qa-empty", TODO_QA, null, null, "todo-qa.md has no QA items", 'Write the QA TODO under "## Checks" as "- [ ] QA-001 (REQ-001) ..." items.');
  for (const [file, parsed] of [[TODO_DEV, devParse], [TODO_QA, qaParse]]) {
    for (const p of parsed.problems) gap(`todo-format-${p.key}`, file, null, p.key === "section" ? null : p.key, `${file}: ${p.problem}`, "Fix the list format: one checkbox line per item, each id once, inside its section.");
  }
  // STARK's contract is the copied text itself, so the copies must match request.md.
  for (const [heading, prefixes] of [["Acceptance", ["REQ"]], ["Do not build", ["OUT", "LATER"]], ["Cautions", ["CAUTION"]]]) {
    const body = section(devText, heading);
    for (const prefix of prefixes) {
      const copied = new Map(sectionItems(body, prefix).map((i) => [i.key, contract(i.text)]));
      for (const item of req[prefix].items) {
        const reqItem = prefix === "REQ" ? item.key : null;
        if (!copied.has(item.key)) gap(`todo-copy-${item.key}`, TODO_DEV, reqItem, null, `${item.key} is missing from the ${heading} section of todo-dev.md`, `Copy ${item.key} from request.md into "## ${heading}", word for word.`);
        else if (copied.get(item.key) !== contract(item.text)) gap(`todo-copy-${item.key}`, TODO_DEV, reqItem, null, `${item.key} in the ${heading} section of todo-dev.md differs from request.md`, `Copy ${item.key} from request.md word for word.`);
      }
    }
  }
  for (const item of req.REQ.items) {
    if (dev.length && !dev.some((d) => d.refs.includes(item.key))) gap(item.key, TODO_DEV, item.key, null, `${item.key} has no development TODO`, `Add a DEV item that implements ${item.key}.`);
    if (qa.length && !qa.some((q) => q.refs.includes(item.key))) gap(item.key, TODO_QA, item.key, null, `${item.key} has no QA TODO`, `Add a QA item that verifies ${item.key}.`);
  }
  for (const d of dev) {
    if (!d.refs.some((r) => r.startsWith("REQ-"))) gap(d.key, TODO_DEV, null, d.key, `${d.key} does not name the request item it implements`, `Add the REQ item(s) in parentheses after ${d.key}.`);
    for (const r of d.refs) {
      if (/^(OUT|LATER)-/.test(r)) gap(d.key, TODO_DEV, null, d.key, `${d.key} builds ${r}, which the request ${r.startsWith("OUT-") ? "puts out of scope" : "defers (not now)"}`, `Remove ${d.key} or the work for ${r}.`);
      else if (!known.has(r)) gap(d.key, TODO_DEV, null, d.key, `${d.key} refers to ${r}, which request.md does not define`, "Refer only to REQ items in request.md.");
    }
  }
  for (const q of qa) {
    if (!q.refs.length) gap(q.key, TODO_QA, null, q.key, `${q.key} does not name the request item it verifies`, `Add the REQ, OUT, LATER or CAUTION item it checks in parentheses after ${q.key}.`);
    for (const r of q.refs) if (!known.has(r)) gap(q.key, TODO_QA, null, q.key, `${q.key} refers to ${r}, which request.md does not define`, "Refer only to items in request.md.");
  }
  return gaps;
}

// ---------- ticking items off, with evidence
// STARK ticks a DEV or FIX item off only through `denken.mjs tick`, which checks the evidence, runs
// the item's test command and, only when it passes, records the tick in a ledger
// (calls/<call>.ticks.jsonl, output in calls/<call>.tick-<item>.log). When the call ends, the engine
// writes each recorded tick and its evidence into the TODO file. The engine is the only writer of
// ticks and evidence, so STARK may not change the TODO files at all. Unticking is the engine's too.
