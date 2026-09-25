// Ticking items off: the tick ledger, checking and applying ticks with their evidence, and the items still open.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { changedSince, changeTree } from "./changes.mjs";
import { hashFile, now, TODO_DEV, TODO_FIX } from "./core.mjs";
import { readRunFile } from "./state.mjs";
import { blockedIn, EVIDENCE_LINE, fixItems, inItemSection, ITEM, parseItems } from "./todo.mjs";

// Evidence as it is written under an item: one line, at most 400 characters. The full text stays
// in the tick ledger and the step file.
export function evidenceLine(evidence) {
  const flat = String(evidence).replace(/\s+/g, " ").trim();
  return flat.length <= 400 ? flat : `${flat.slice(0, 360)} … (truncated; full text in the tick record)`;
}

export function setTick(runDir, prefix, key, ticked, evidence = null) {
  const path = join(runDir, ITEM[prefix].file);
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^\\s*[-*]\\s*\\[[ xX]\\]\\s*[*_\`]*(${prefix}-\\d{3,})\\b`));
    if (!m || m[1] !== key || !inItemSection(lines, i, ITEM[prefix].heading)) continue;
    lines[i] = lines[i].replace(/\[[ xX]\]/, ticked ? "[x]" : "[ ]");
    let j = i + 1;
    while (j < lines.length && /^\s{2,}\S/.test(lines[j]) && !EVIDENCE_LINE.test(lines[j])) j++;
    const has = j < lines.length && EVIDENCE_LINE.test(lines[j]);
    if (ticked && evidence) {
      const line = `  Evidence: ${evidenceLine(evidence)}`;
      if (has) lines[j] = line;
      else lines.splice(i + 1, 0, line);
    } else if (!ticked && has) lines.splice(j, 1);
    writeFileSync(path, lines.join("\n"));
    return true;
  }
  return false;
}

// Ledger entries whose output log is intact, keyed by item, latest first wins.
export function tickLedger(runDir) {
  const entries = new Map();
  for (const f of existsSync(join(runDir, "calls")) ? readdirSync(join(runDir, "calls")) : []) {
    if (!/^dev-stark-\d+\.ticks\.jsonl$/.test(f)) continue;
    for (const line of readFileSync(join(runDir, "calls", f), "utf8").split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.exitCode === 0 && hashFile(join(runDir, "calls", e.log)) === e.logSha && (!entries.has(e.item) || e.at > entries.get(e.item).at)) entries.set(e.item, e);
      } catch {}
    }
  }
  return entries;
}

// After STARK's call: every DEV item, and every FIX item of the current QA cycle, is either
// ticked off with evidence and a passing test run recorded since it was last unticked, or
// reported blocked in dev-report.md.
// Ticks recorded by one call, the latest per item, applied to the TODO files when the call ends.
// The ledger is one of STARK's own call files, so every check the tick command made is made
// again here; an entry that fails one is not applied, and goes back to STARK with the reason.
// Each applied tick's base (when, and the changed files' state) is kept in state.json, the only
// place itemBase reads it from.
export function applyTicks(runDir, state, call) {
  const latest = new Map();
  for (const line of readRunFile(runDir, `calls/${call.id}.ticks.jsonl`).split("\n").filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e.item === "string") latest.set(e.item, e);
    } catch {}
  }
  const applied = [];
  const rejected = [];
  for (const [key, e] of latest) {
    const problem = tickProblem(runDir, state, call, e);
    if (problem) {
      rejected.push({ item: key, problem });
      continue;
    }
    setTick(runDir, key.split("-")[0], key, true, e.evidence);
    (state.tickBases ??= {})[key] = { at: now(), call: call.id };
    applied.push(e);
  }
  // Bases are taken after every tick of the call is applied, from the files as the call left them.
  const tree = changeTree(state);
  for (const e of applied) state.tickBases[e.item].tree = tree;
  return { applied, rejected };
}

export function tickProblem(runDir, state, call, e) {
  const prefix = /^(DEV|FIX)-\d{3,}$/.test(e.item) ? e.item.split("-")[0] : null;
  if (!prefix) return "it is not a DEV or FIX item";
  const items = prefix === "DEV" ? parseItems(readRunFile(runDir, TODO_DEV), "DEV").items : fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle);
  if (!items.some((x) => x.key === e.item)) return prefix === "DEV" ? "it is not in the TODO section of todo-dev.md" : "it is not a recovery item of the current QA cycle";
  if (typeof e.evidence !== "string" || !e.evidence.trim() || typeof e.noChange !== "boolean") return "the record has no evidence";
  if (e.noChange ? !/^No change needed: \S/.test(e.evidence) : /^No change needed:/.test(e.evidence)) return "the record mixes --evidence and --no-change";
  if (e.log !== `${call.id}.tick-${e.item}.log`) return "the record points to the wrong test log";
  const log = readRunFile(runDir, `calls/${e.log}`);
  if (typeof e.command !== "string" || !log.startsWith(`$ ${e.command}\n`) || !/\n\[exit 0\]\n?$/.test(log)) return "its test log does not show the recorded command passing";
  if (!e.noChange) {
    const base = itemBase(runDir, state, e.item);
    if (!changedSince(state, base.tree).some((f) => namesFile(e.evidence, f))) return `its evidence names no file changed for it since ${base.what}`;
  }
  return null;
}

// Where an item's evidence is measured from: whichever came last of the start of development, the
// item's own last applied tick, the engine unticking it, and (for a FIX item) the QA cycle that
// wrote it. All of these come from state.json, which only the engine writes.
export function itemBase(runDir, state, key) {
  const start = state.stageEnteredAt?.dev ?? "";
  const bases = [{ at: start, tree: {}, what: "development began" }];
  const t = state.tickBases?.[key];
  if (t?.tree) bases.push({ at: t.at, tree: t.tree, what: `${key} was last ticked (${t.call})` });
  const u = state.unticked?.[key];
  if (u) bases.push({ at: u.at, tree: u.tree, what: `the engine unticked ${key} after QA failed` });
  const cycle = key.startsWith("FIX-") ? state.fixCycles?.[state.currentFixCycle] : null;
  if (cycle?.tree) bases.push({ at: cycle.at, tree: cycle.tree, what: `QA cycle ${state.currentFixCycle} wrote ${key}` });
  return bases.filter((b) => b.at >= start).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
}

// Does the evidence name this file, by its path or by its file name (when it has an extension),
// as a whole name? "a.js" does not name "a.jsx" or "a.js.bak".
export function namesFile(evidence, file) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forms = [file, ...(/\.\w+$/.test(basename(file)) ? [basename(file)] : [])];
  return forms.some((n) => new RegExp(`(^|[^\\w./-])${esc(n)}(?=$|[^\\w./-]|\\.(?:$|\\s))`).test(evidence));
}

export function devGaps(runDir, state, rejected = []) {
  const report = readRunFile(runDir, "dev-report.md");
  const items = [
    ...parseItems(readRunFile(runDir, TODO_DEV), "DEV").items.map((d) => ({ ...d, file: TODO_DEV })),
    ...fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle).map((f) => ({ ...f, file: TODO_FIX })),
  ];
  const gaps = [];
  for (const d of items) {
    if (d.done || blockedIn(report, d.key)) continue;
    const refused = rejected.find((r) => r.item === d.key);
    gaps.push({ identity: d.key, severity: "blocking", topic: d.key, file: d.file, line_start: null, line_end: null, request_item: d.refs.find((r) => r.startsWith("REQ-")) ?? null, todo: d.key, source: "engine", problem: refused ? `${d.key}'s recorded tick was not accepted: ${refused.problem}` : `${d.key} is neither ticked off nor reported blocked in dev-report.md`, required_change: `Finish ${d.key} and tick it off with the tick command and its evidence, or report "${d.key} blocked: <reason>" in dev-report.md.` });
  }
  return gaps;
}
