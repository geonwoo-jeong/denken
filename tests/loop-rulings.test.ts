// DENKEN engine tests: DENKEN's rulings on repeated topics, stalls and QA failures, and deferred findings.
import { changes, finding, qaItem } from "./test-scenario.ts";
import { listAt, textAt } from "./test-json.ts";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const FIRST = 1,
  SECOND = 2,
  ONE_DEFERRED = 1,
  NAMING = changes(finding("naming", { file: "todo-dev.md" })),
  // Three rejections in a row, each on a different topic.
  STALLED = { "plan-richter-1": changes(finding("a")), "plan-richter-2": changes(finding("b")), "plan-richter-3": changes(finding("c")) },
  // The test project's run, started.
  start = async (run: TestRun): Promise<TestRun> => {
    await run.denken("start", run.run);
    return run;
  },
  dismissApproves = async (): Promise<void> => {
    const run = await start(await setup({ "plan-richter-1": NAMING, "plan-richter-2": NAMING, "plan-richter-3": NAMING })),
      blocked = await run.drive(),
      ruled = await run.denken("rule", run.run, "--decision", "dismiss", "--note", "Naming is a preference, not a requirement."),
      done = await run.drive(),
      calls = await run.calls(),
      state = await run.state(),
      verdicts = await readOr(path.join(run.proj, textAt(state, "log"), "verdicts.md"), "");
    assert.equal(textAt(blocked, "action"), "needs_ruling");
    assert.equal(textAt(ruled.json, "action"), "ruled");
    assert.equal(textAt(done, "action"), "done");
    assert.ok(!calls.includes("claude plan-methode-4 rw"));
    assert.ok(listAt(state, "deferred").some((item) => textAt(item, "severity") === "dismissed"));
    // The approval that came from the ruling is recorded as such.
    assert.match(
      verdicts,
      /· Planning review · DENKEN · \*\*APPROVED\*\* \(by ruling R1\) · no blocking finding is left open: todo-dev\.md::naming dismissed → 01-planning\/\d+_denken-ruling-R1-dismiss\.md/u,
    );
  },
  nonblockingDeferred = async (): Promise<void> => {
    const run = await start(await setup({ "plan-richter-1": { review: { checked: [], findings: [finding("typo", { severity: "nonblocking" })], verdict: "APPROVED" } } })),
      done = await run.drive(),
      calls = await run.calls(),
      state = await run.state();
    assert.equal(textAt(done, "action"), "done");
    assert.ok(!calls.includes("claude plan-methode-2 rw"));
    assert.equal(listAt(state, "deferred").length, ONE_DEFERRED);
  },
  stalledLoop = async (): Promise<void> => {
    const run = await start(await setup(STALLED)),
      blocked = await run.drive();
    assert.equal(textAt(blocked, "action"), "needs_ruling");
    assert.equal(textAt(blocked, "reason"), "stalled");
  },
  dismissedRequestItem = async (): Promise<void> => {
    const fail = { qa: { items: [qaItem(FIRST, "FAIL"), qaItem(SECOND)], result: "FAIL" } },
      run = await start(await setup({ "qa-genau-1": fail, "qa-genau-2": fail, "qa-genau-3": fail, "qa-genau-4": fail }, { limits: { topicRepeats: 2 } })),
      blocked = await run.drive(),
      ruled = await run.denken("rule", run.run, "--decision", "dismiss", "--identities", "REQ-001", "--note", "Criterion 1 needs network access; out of scope for this environment."),
      done = await run.drive();
    assert.equal(textAt(blocked, "action"), "needs_ruling");
    assert.equal(textAt(blocked, "reason"), "qa_repeated_failure");
    assert.deepEqual(listAt(blocked, "identities"), ["REQ-001"]);
    assert.equal(textAt(ruled.json, "action"), "ruled");
    assert.equal(textAt(done, "action"), "done");
  };

await test("dismissing the only open topic approves the stage", dismissApproves);
await test("nonblocking findings are deferred and do not block approval", nonblockingDeferred);
await test("a stalled loop asks for a ruling even when topics differ", stalledLoop);
await test("a dismissed request item no longer fails QA", dismissedRequestItem);
