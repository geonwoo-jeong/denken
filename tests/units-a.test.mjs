// DENKEN engine tests: units-a. Shared setup is in helpers.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changes, FAKE, finding, qaItem, REQUEST, SCRIPTS, setup, TWO_UNITS } from "./helpers.mjs";

test("units: each unit plans, builds, is reviewed and verified in its own worktree, all at once; the merge is then reviewed and verified again", () => {
  // UNIT-1's planner is slow, so UNIT-2 gets ahead of it: the units really run side by side.
  const t = setup({ "UNIT-1:plan-methode-1": { sleepMs: 2000 } });
  t.split(TWO_UNITS);
  const started = t.denken("start", t.run).json;
  assert.deepEqual(started.units.map((u) => [u.unit, u.scope]), [["UNIT-1", ["a/"]], ["UNIT-2", ["b/"]]]);
  assert.equal(t.worktrees(), 3);
  const end = t.drive();
  assert.equal(end.action, "done", JSON.stringify(end, null, 1));
  const calls = t.calls();
  assert.ok(calls.indexOf("codex UNIT-2:plan-richter-1 ro") < calls.indexOf("codex UNIT-1:plan-richter-1 ro"), calls.join("\n"));
  for (const u of ["UNIT-1", "UNIT-2"]) {
    for (const c of ["claude %:plan-methode-1 rw", "codex %:plan-richter-1 ro", "codex %:dev-stark-1 rw", "claude %:dev-ubel-1 ro", "claude %:qa-genau-1 rw"]) assert.ok(calls.includes(c.replace("%", u)), `${u}: ${c}`);
  }
  // After the merge, in the project: UBEL on the merged change, GENAU again, then the docs.
  assert.deepEqual(calls.slice(-4), ["claude dev-ubel-1 ro", "claude qa-genau-1 rw", "claude wiki-serie-1 rw", "codex wiki-frieren-1 ro"]);
  assert.match(readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.prompt.md"), "utf8"), /merged result of units built in parallel/);
  // A unit's Claude agents may not edit the main checkout; the project's own calls have no such rule.
  const settingsOf = (key) => JSON.parse(t.argsOf(key)[t.argsOf(key).indexOf("--settings") + 1]);
  const main = realpathSync(t.proj);
  const denied = ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(//${main.slice(1)}/**)`);
  assert.deepEqual(settingsOf("UNIT-1:plan-methode-1").permissions.deny, denied);
  assert.deepEqual(settingsOf("UNIT-2:qa-genau-1").permissions.deny, denied);
  assert.equal(settingsOf("qa-genau-1").permissions, undefined);
  assert.ok(t.argsOf("UNIT-1:plan-methode-1").includes("--exclude-dynamic-system-prompt-sections"));
  assert.equal(readFileSync(join(t.proj, "a", "work.txt"), "utf8"), "change 1\n");
  assert.equal(readFileSync(join(t.proj, "b", "work.txt"), "utf8"), "change 1\n");
  // The merged lists: every DEV item as the unit ticked it, and every check verified again.
  const todoDev = readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8");
  assert.match(todoDev, /### UNIT-1: One\n\n- \[x\] DEV-101 \(REQ-001\) build REQ-001\. Files: `a\/work\.txt`\.\n {2}Evidence: changed a\/work\.txt/);
  assert.match(todoDev, /### UNIT-2: Two\n\n- \[x\] DEV-201 \(REQ-002\)/);
  const todoQa = readFileSync(join(t.proj, t.run, "todo-qa.md"), "utf8");
  assert.match(todoQa, /- \[x\] QA-001 \(REQ-001, REQ-002\) The project's whole test suite passes on the merged result\./);
  assert.match(todoQa, /- \[x\] QA-101 \(REQ-001\)[^\n]*\n {2}Evidence: ok \(verified by: fake; qa-genau-1\)/);
  // One record: each unit's steps in its own folders, every verdict in one file.
  const log = join(t.proj, t.state().log);
  assert.deepEqual(readdirSync(join(log, "01-planning")).filter((f) => f.startsWith("UNIT")), ["UNIT-1", "UNIT-2"]);
  assert.ok(existsSync(join(log, "03-qa", "UNIT-2", "qa-1", "report.md")));
  assert.ok(existsSync(join(log, "raw", "UNIT-1", "merge.patch")));
  const verdicts = readFileSync(join(log, "verdicts.md"), "utf8");
  for (const line of [
    /· UNIT-1 · Planning, round 1 · METHODE \(claude\) · plan-methode-1 · \*\*READY\*\* · [^\n]* → 01-planning\/UNIT-1\/01_methode-round1\.md/,
    /· UNIT-2 · Independent QA, cycle 1 · GENAU \(claude\) · qa-genau-1 · \*\*PASSED\*\*/,
    /· UNIT-1 · Unit · ENGINE · \*\*DONE\*\*/,
    /· Merge · ENGINE · \*\*MERGED\*\* · UNIT-1 \(1 file\(s\)\), UNIT-2 \(1 file\(s\)\) merged into the project/,
    /· Development review of the merged units, round 1 · UBEL \(claude\) · dev-ubel-1 · \*\*APPROVED\*\*/,
    /· Independent QA after the merge, cycle 1 · GENAU \(claude\) · qa-genau-1 · \*\*PASSED\*\*/,
  ]) assert.match(verdicts, line);
  // The worktrees are gone once the units are merged.
  assert.equal(t.worktrees(), 1);
  assert.ok(!existsSync(dirname(t.state().unitHome)));
});

test("units: a split whose scopes overlap, or that leaves out or repeats a REQ item, is refused", () => {
  const t = setup();
  t.split("- UNIT-1 (REQ-001) One. Scope: `a/`.\n- UNIT-2 (REQ-002) Two. Scope: `a/deep/`.\n");
  assert.match(t.denken("start", t.run).json.error, /UNIT-1 and UNIT-2 overlap at a\/ and a\/deep\/: work whose scope overlaps is not split\. Put it in one unit/);
  writeFileSync(join(t.proj, t.run, "units.md"), "- UNIT-1 (REQ-001, REQ-002) One. Scope: `a/`.\n- UNIT-2 (REQ-002, REQ-003) Two. Scope: `b/*`.\n");
  const error = t.denken("start", t.run).json.error;
  for (const p of [/REQ-002 is in UNIT-1 and UNIT-2; each REQ item belongs to exactly one unit/, /UNIT-2 names REQ-003, which request\.md does not define/, /scope "b\/\*" must be a plain path/]) assert.match(error, p);
  assert.equal(t.worktrees(), 1);
});

test("units: a unit plans and changes only inside its scope", () => {
  const t = setup({
    "UNIT-1:plan-methode-1": { devFiles: ["a/work.txt", "b/keep.txt"] },
    "UNIT-1:dev-stark-1": { editFiles: { "b/stray.txt": "x\n" } },
    "UNIT-1:dev-stark-2": { removeFiles: ["b/stray.txt"] },
  });
  t.split(TWO_UNITS);
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const verdicts = readFileSync(join(t.proj, t.state().log, "verdicts.md"), "utf8");
  assert.match(verdicts, /· UNIT-1 · Planning check, round 1 · ENGINE · plan-methode-1 · \*\*RETURNED\*\* · DEV-101 names b\/keep\.txt, outside UNIT-1's scope \(a\/\)/);
  assert.match(verdicts, /· UNIT-1 · Development check, round 1 · ENGINE · dev-stark-1 · \*\*RETURNED\*\* · b\/stray\.txt changed, outside UNIT-1's scope \(a\/\)/);
  assert.ok(!existsSync(join(t.proj, "b", "stray.txt")));
});

test("units: what a unit needs from DENKEN comes through the parent, and is answered there with --unit", () => {
  const naming = changes(finding("naming", { file: "todo-dev.md" }));
  const t = setup({ "UNIT-2:plan-richter-1": naming, "UNIT-2:plan-richter-2": naming, "UNIT-2:plan-richter-3": naming });
  t.split(TWO_UNITS);
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.action, "needs_ruling");
  assert.equal(r.unit, "UNIT-2");
  assert.match(r.next, /--unit UNIT-2/);
  assert.match(t.denken("rule", t.run, "--decision", "uphold", "--note", "x").json.error, /the decisions are replan \(a new split\) or abort/);
  assert.equal(t.denken("rule", t.run, "--unit", "UNIT-2", "--decision", "dismiss", "--note", "Naming is a preference.").json.action, "ruled");
  assert.equal(t.drive().action, "done");
  assert.match(readFileSync(join(t.proj, t.state().log, "verdicts.md"), "utf8"), /· UNIT-2 · Ruling R1 on todo-dev\.md::naming · DENKEN · \*\*DISMISS\*\*/);
});
