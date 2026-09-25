// DENKEN engine tests: units built side by side, each in its own worktree, then merged and checked again.
import type { JsonValue, TestRun } from "./test-types.ts";
import { MISSING, at, listAt, parsed, textAt } from "./test-json.ts";
import { fileExists, readOr } from "./test-log.ts";
import { readdir, realpath } from "node:fs/promises";
import { TWO_UNITS } from "./test-scenario.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const SLOW_MS = 6000,
  SPLIT_WORKTREES = 3,
  MAIN_WORKTREE = 1,
  LAST_FOUR = -4,
  NEXT = 1,
  UNIT_CALLS: readonly string[] = ["claude %:plan-methode-1 rw", "codex %:plan-richter-1 ro", "codex %:dev-stark-1 rw", "claude %:dev-ubel-1 ro", "claude %:qa-genau-1 rw"],
  AFTER_MERGE: readonly string[] = ["claude dev-ubel-1 ro", "claude qa-genau-1 rw", "claude wiki-serie-1 rw", "codex wiki-frieren-1 ro"],
  settingsOf = async (run: TestRun, key: string): Promise<JsonValue | symbol> => {
    const args = await run.argsOf(key);
    return parsed(args[args.indexOf("--settings") + NEXT] ?? "");
  },
  checkStart = async (run: TestRun): Promise<void> => {
    const started = await run.denken("start", run.run),
      units = listAt(started.json, "units").map((unit) => [textAt(unit, "unit"), listAt(unit, "scope")]);
    assert.deepEqual(units, [["UNIT-1", ["a/"]], ["UNIT-2", ["b/"]]]);
    assert.equal(await run.worktrees(), SPLIT_WORKTREES);
  },
  checkDone = async (run: TestRun): Promise<void> => {
    const end = await run.drive();
    assert.equal(textAt(end, "action"), "done", JSON.stringify(end));
  },
  checkCalls = async (run: TestRun): Promise<void> => {
    const calls = await run.calls(),
      prompt = await readOr(path.join(run.proj, run.run, "calls", "dev-ubel-1.prompt.md"), "");
    assert.ok(calls.indexOf("codex UNIT-2:plan-richter-1 ro") < calls.indexOf("codex UNIT-1:plan-richter-1 ro"), calls.join("\n"));
    for (const unit of ["UNIT-1", "UNIT-2"]) {
      for (const call of UNIT_CALLS) {
        assert.ok(calls.includes(call.replace("%", unit)), `${unit}: ${call}`);
      }
    }
    // After the merge, in the project: UBEL on the merged change, GENAU again, then the docs.
    assert.deepEqual(calls.slice(LAST_FOUR), AFTER_MERGE);
    assert.match(prompt, /merged result of units built in parallel/u);
  },
  // A unit's Claude agents may not edit the main checkout; the project's own calls have no such rule.
  checkSettings = async (run: TestRun): Promise<void> => {
    const main = await realpath(run.proj),
      denied = ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(//${main.slice(NEXT)}/**)`),
      args = await run.argsOf("UNIT-1:plan-methode-1");
    assert.deepEqual(listAt(await settingsOf(run, "UNIT-1:plan-methode-1"), "permissions", "deny"), denied);
    assert.deepEqual(listAt(await settingsOf(run, "UNIT-2:qa-genau-1"), "permissions", "deny"), denied);
    assert.equal(at(await settingsOf(run, "qa-genau-1"), "permissions"), MISSING);
    assert.notEqual(await settingsOf(run, "qa-genau-1"), MISSING);
    assert.ok(args.includes("--exclude-dynamic-system-prompt-sections"));
  },
  // The merged lists: every DEV item as the unit ticked it, and every check verified again.
  checkFiles = async (run: TestRun): Promise<void> => {
    const todoDev = await readOr(path.join(run.proj, run.run, "todo-dev.md"), ""),
      todoQa = await readOr(path.join(run.proj, run.run, "todo-qa.md"), "");
    assert.equal(await readOr(path.join(run.proj, "a", "work.txt"), ""), "change 1\n");
    assert.equal(await readOr(path.join(run.proj, "b", "work.txt"), ""), "change 1\n");
    assert.match(todoDev, /### UNIT-1: One\n\n- \[x\] DEV-101 \(REQ-001\) build REQ-001\. Files: `a\/work\.txt`\.\n {2}Evidence: changed a\/work\.txt/u);
    assert.match(todoDev, /### UNIT-2: Two\n\n- \[x\] DEV-201 \(REQ-002\)/u);
    assert.match(todoQa, /- \[x\] QA-001 \(REQ-001, REQ-002\) The project's whole test suite passes on the merged result\./u);
    assert.match(todoQa, /- \[x\] QA-101 \(REQ-001\)[^\n]*\n {2}Evidence: ok \(verified by: fake; qa-genau-1\)/u);
  },
  VERDICT_LINES: readonly RegExp[] = [
    /· UNIT-1 · Planning, round 1 · METHODE \(claude\) · plan-methode-1 · \*\*READY\*\* · [^\n]* → 01-planning\/UNIT-1\/01_methode-round1\.md/u,
    /· UNIT-2 · Independent QA, cycle 1 · GENAU \(claude\) · qa-genau-1 · \*\*PASSED\*\*/u,
    /· UNIT-1 · Unit · ENGINE · \*\*DONE\*\*/u,
    /· Merge · ENGINE · \*\*MERGED\*\* · UNIT-1 \(1 file\(s\)\), UNIT-2 \(1 file\(s\)\) merged into the project/u,
    /· Development review of the merged units, round 1 · UBEL \(claude\) · dev-ubel-1 · \*\*APPROVED\*\*/u,
    /· Independent QA after the merge, cycle 1 · GENAU \(claude\) · qa-genau-1 · \*\*PASSED\*\*/u,
  ],
  // One record: each unit's steps in its own folders, every verdict in one file.
  checkRecord = async (run: TestRun): Promise<void> => {
    const log = path.join(run.proj, textAt(await run.state(), "log")),
      planning = await readdir(path.join(log, "01-planning")),
      verdicts = await readOr(path.join(log, "verdicts.md"), "");
    assert.deepEqual(planning.filter((name) => name.startsWith("UNIT")), ["UNIT-1", "UNIT-2"]);
    assert.ok(await fileExists(path.join(log, "03-qa", "UNIT-2", "qa-1", "report.md")));
    assert.ok(await fileExists(path.join(log, "raw", "UNIT-1", "merge.patch")));
    for (const line of VERDICT_LINES) {
      assert.match(verdicts, line);
    }
  },
  // The worktrees are gone once the units are merged.
  checkCleanup = async (run: TestRun): Promise<void> => {
    const home = textAt(await run.state(), "unitHome");
    assert.equal(await run.worktrees(), MAIN_WORKTREE);
    assert.ok(!(await fileExists(path.dirname(home))));
  },
  unitsSideBySide = async (): Promise<void> => {
    // UNIT-1's planner is slow, so UNIT-2 gets ahead of it: the units really run side by side.
    const run = await setup({ "UNIT-1:plan-methode-1": { sleepMs: SLOW_MS } });
    await run.split(TWO_UNITS);
    await checkStart(run);
    await checkDone(run);
    await checkCalls(run);
    await checkSettings(run);
    await checkFiles(run);
    await checkRecord(run);
    await checkCleanup(run);
  };

await test("units: each unit plans, builds, is reviewed and verified in its own worktree, all at once; the merge is then reviewed and verified again", unitsSideBySide);
