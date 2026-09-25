// DENKEN engine tests: QA failures, the recovery TODO, and repeated QA cycles. Shared setup is in helpers.ts.
import type { JsonObject, TestRun } from "./test-types.ts";
import { keysAt, listAt, textAt } from "./test-json.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { qaItem } from "./test-scenario.ts";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const FIRST = 1,
  SECOND = 2,
  // QA passes the first item and fails the second, with a check text that names the attempt.
  failing = (attempt: number): JsonObject => ({ qa: { items: [qaItem(FIRST), qaItem(SECOND, "FAIL", { check: `check 2 attempt ${attempt}` })], result: "FAIL" } }),
  SCENARIO: JsonObject = { "dev-stark-2": { fixTick: false }, "qa-genau-1": failing(FIRST), "qa-genau-2": failing(SECOND) },
  /*
   * After the first QA cycle: STARK leaves FIX-001 unticked and goes straight back to STARK; QA then
   * fails again, and a second recovery cycle follows.
   */
  AFTER_QA: readonly string[] = [
    "claude qa-genau-1 rw",
    "codex dev-stark-2 rw",
    "codex dev-stark-3 rw",
    "claude dev-ubel-3 ro",
    "claude qa-genau-2 rw",
    "codex dev-stark-4 rw",
    "claude dev-ubel-4 ro",
    "claude qa-genau-3 rw",
    "claude wiki-serie-1 rw",
    "codex wiki-frieren-1 ro",
  ],
  started = async (scenario: JsonObject): Promise<TestRun> => {
    const run = await setup(scenario),
      start = await run.denken("start", run.run);
    assert.equal(textAt(start.json, "action"), "started");
    return run;
  },
  checkAfterRuling = async (run: TestRun): Promise<void> => {
    const done = await run.drive(),
      calls = await run.calls(),
      fix = await readOr(path.join(run.proj, run.run, "todo-fix.md"), ""),
      state = await run.state();
    assert.equal(textAt(done, "action"), "done");
    assert.deepEqual(calls.slice(calls.indexOf("claude qa-genau-1 rw")), AFTER_QA);
    assert.match(fix, /## QA cycle 1\n\n- \[x\] FIX-001 \(QA-002, REQ-002\) Fix: check 2 attempt 1/u);
    assert.match(fix, /## QA cycle 2\n\n- \[x\] FIX-002 \(QA-002, REQ-002\) Fix: check 2 attempt 2/u);
    assert.deepEqual(keysAt(state, "fixCycles"), ["1", "2"]);
  },
  recoveryCycles = async (): Promise<void> => {
    const run = await started(SCENARIO),
      ruling = await run.drive();
    // The same failure twice in a row: the engine cannot find the root cause, so DENKEN is called in.
    assert.equal(textAt(ruling, "reason"), "qa_repeated_failure");
    assert.deepEqual(listAt(ruling, "identities"), ["REQ-002"]);
    await run.denken("rule", run.run, "--decision", "uphold", "--note", "Keep going: the recovery item names the real cause.");
    await checkAfterRuling(run);
  };

await test("QA failures become a recovery TODO; unticked FIX items go back to STARK; cycles repeat until QA passes", recoveryCycles);
