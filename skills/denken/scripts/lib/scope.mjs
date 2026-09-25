// Facts about a change's scope and tests, for UBEL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stageChanges } from "./changes.mjs";
import { EMPTY_TREE, EXCLUDE, ROOT, TODO_DEV } from "./core.mjs";
import { git } from "./git.mjs";
import { readRunFile } from "./state.mjs";
import { tickLedger } from "./ticks.mjs";
import { blockedIn, EVIDENCE_LINE, fixItems, parseItems } from "./todo.mjs";

// Facts for UBEL: each item's status, evidence and test run, the change's scope against the files
// the DEV items name, and signs of weakened tests.
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.\w+$|_test\.\w+$/;

export const SKIP_MARKER = /\.skip\(|\bxit\(|\bxdescribe\(|\bxtest\(|@pytest\.mark\.skip|\bt\.Skip\(|skip:\s*true|\.todo\(/;

export function scopeReport(runDir, state) {
  const base = state.stageBase.dev || EMPTY_TREE;
  const { changed, untracked } = stageChanges(state, "dev");
  const report = readRunFile(runDir, "dev-report.md");
  const ledger = tickLedger(runDir);
  const items = parseItems(readRunFile(runDir, TODO_DEV), "DEV").items;
  const fixes = fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle);
  const pathLike = (t) => /^[\w.\/-]+$/.test(t) && (t.includes("/") || /\.\w+$/.test(t));
  // A name without an extension is taken as a directory, and covers everything under it.
  const covers = (name, file) => file === name || (!/\.\w+$/.test(name) && file.startsWith(`${name.replace(/\/$/, "")}/`));
  const planned = (d) => d.block.split("\n").filter((l) => !EVIDENCE_LINE.test(l)).join("\n");
  const named = new Map(items.map((d) => [d.key, [...planned(d).matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(pathLike)]));
  const allNamed = [...named.values()].flat();
  const ticked = items.filter((d) => d.done);

  const status = [...items, ...fixes].map((d) => {
    const e = ledger.get(d.key);
    const run = e ? `, test \`${e.command}\` exit 0 (${e.lastLine || "no output"})` : "";
    const evidence = d.evidence ? `, evidence: "${d.evidence}"` : "";
    return `${d.key} ${d.done ? "[x]" : "[ ]"}${!d.done && blockedIn(report, d.key) ? " reported blocked" : ""}${evidence}${run}`;
  });
  const unnamed = changed.filter((f) => !allNamed.some((n) => covers(n, f)));
  const untouched = ticked.filter((d) => named.get(d.key).length && !named.get(d.key).some((n) => changed.some((f) => covers(n, f))));
  const nameless = ticked.filter((d) => !named.get(d.key).length);
  const untested = ticked.filter((d) => !named.get(d.key).some((n) => TEST_FILE.test(n) && changed.some((f) => covers(n, f))));

  const diff = git("diff", base, "--", ".", ...EXCLUDE).toString("utf8");
  const deletions = new Map();
  const skips = [];
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("--- ")) continue;
    else if (file && TEST_FILE.test(file) && line.startsWith("-") && line.slice(1).trim()) deletions.set(file, (deletions.get(file) ?? 0) + 1);
    else if (file && line.startsWith("+") && SKIP_MARKER.test(line)) skips.push(`${file}: ${line.slice(1).trim().slice(0, 80)}`);
  }
  for (const f of untracked.filter((f) => TEST_FILE.test(f))) {
    for (const line of readFileSync(join(ROOT, f), "utf8").split("\n")) if (SKIP_MARKER.test(line)) skips.push(`${f}: ${line.trim().slice(0, 80)}`);
  }
  const list = (xs, fmt = (x) => x) => (xs.length ? xs.map(fmt).join(", ") : "none");
  const withFiles = (d) => `${d.key} (${named.get(d.key).join(", ")})`;
  return [
    `Items, evidence and recorded test runs: ${list(status)}`,
    `Files changed in this stage: ${list(changed)}`,
    `Changed files that no DEV item names: ${list(unnamed)}. Judge whether each belongs to the plan.`,
    `Ticked DEV items none of whose named files changed: ${list(untouched, withFiles)}. Check that they were really done.`,
    `Ticked DEV items that name no files: ${list(nameless, (d) => d.key)}.`,
    `Ticked DEV items with no named test file added or changed: ${list(untested, (d) => d.key)}.`,
    `Items ticked as needing no change: ${list([...items, ...fixes].filter((d) => d.done && ledger.get(d.key)?.noChange), (d) => `${d.key} (${ledger.get(d.key).evidence})`)}. Judge whether each reason holds.`,
    `Lines deleted from test files: ${list([...deletions], ([f, n]) => `${f} (${n})`)}. Check that no test was weakened.`,
    `Skip markers added: ${list(skips)}.`,
  ].join("\n  ");
}
