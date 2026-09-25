// DENKEN engine tests: how many units work at once, a project that changes under them, and QA after the merge.
import type { Ran, TestRun } from "./test-types.ts";
import { listAt, textAt } from "./test-json.ts";
import { TWO_UNITS } from "./test-scenario.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const LAST_SEVEN = -7,
  AFTER_MERGE: readonly string[] = [
    "claude dev-ubel-1 ro",
    "claude qa-genau-1 rw",
    "codex dev-stark-2 rw",
    "claude dev-ubel-2 ro",
    "claude qa-genau-2 rw",
    "claude wiki-serie-1 rw",
    "codex wiki-frieren-1 ro",
  ],
  MERGED_QA = {
    qa: {
      items: [
        { check: "suite", evidence: "ok", how_verified: "npm test", id: "QA-001", request_item: "REQ-001", result: "PASS" },
        { check: "one", evidence: "boom", how_verified: "x", id: "QA-101", reproduce: "npm test", request_item: "REQ-001", result: "FAIL" },
        { check: "two", evidence: "ok", how_verified: "x", id: "QA-201", request_item: "REQ-002", result: "PASS" },
      ],
      result: "FAIL",
      summary: "UNIT-1's check fails once merged.",
    },
  },
  // The run, split into units a/ and b/, and started.
  startSplit = async (run: TestRun): Promise<Ran> => {
    await run.split(TWO_UNITS);
    const started = await run.denken("start", run.run);
    return started;
  },
  parallelCap = async (): Promise<void> => {
    const run = await setup({}, { limits: { parallelUnits: 1 } }),
      started = await startSplit(run),
      done = await run.drive(),
      calls = await run.calls();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.ok(calls.indexOf("claude UNIT-2:plan-methode-1 rw") > calls.indexOf("codex UNIT-1:plan-richter-1 ro"));
    assert.ok(calls.indexOf("codex UNIT-2:dev-stark-1 rw") > calls.indexOf("claude UNIT-1:qa-genau-1 rw"));
  },
  mainTreeChanged = async (): Promise<void> => {
    const run = await setup({ "UNIT-1:dev-stark-1": { touch: "$PROJ/a.txt" } }),
      started = await startSplit(run),
      blocked = await run.drive(),
      resumed = await run.denken("retry", run.run),
      done = await run.drive();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(blocked, "reason"), "main_tree_changed");
    assert.deepEqual(listAt(blocked, "status"), ["M a.txt"]);
    assert.equal(textAt(resumed.json, "action"), "resumed");
    assert.equal(textAt(done, "action"), "done");
    assert.equal(await readOr(path.join(run.proj, "a.txt"), ""), "a\ntampered\n");
  },
  failureAfterMerge = async (): Promise<void> => {
    const run = await setup({ "qa-genau-1": MERGED_QA }),
      started = await startSplit(run),
      done = await run.drive(),
      calls = await run.calls();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.deepEqual(calls.slice(LAST_SEVEN), AFTER_MERGE);
    assert.match(await readOr(path.join(run.proj, run.run, "todo-fix.md"), ""), /- \[x\] FIX-001 \(QA-101, REQ-001\) Fix: one/u);
    assert.match(await readOr(path.join(run.proj, run.run, "todo-dev.md"), ""), /- \[x\] DEV-101 \(REQ-001\)[^\n]*\n {2}Evidence: changed src\.txt/u);
  };

await test("units: limits.parallelUnits caps how many units work at once", parallelCap);
await test("units: a change to the project while units work stops the run until the user says so", mainTreeChanged);
await test("units: a failure found after the merge is fixed in the project, reviewed and verified again", failureAfterMerge);
