// DENKEN engine tests: what a dismissal must name, and what counts as the same topic. Shared setup is in helpers.ts.
import type { JsonObject, JsonValue, TestRun } from "./test-types.ts";
import { changes, finding } from "./test-scenario.ts";
import { listAt, textAt } from "./test-json.ts";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const FAILED = 1,
  BOTH = 2,
  RAISED = 3,
  STALLING: JsonObject = {
    "plan-richter-1": changes(finding("a")),
    "plan-richter-2": changes(finding("b")),
    "plan-richter-3": changes(finding("c"), finding("d", { file: "other.txt" })),
  },
  started = async (run: TestRun): Promise<JsonValue | symbol> => {
    await run.denken("start", run.run);
    const end = await run.drive();
    return end;
  },
  // Dismissing one of the two open findings leaves the other open: the planner works on.
  oneDismissed = async (): Promise<void> => {
    const run = await setup(STALLING),
      stalled = await started(run),
      blanket = await run.denken("rule", run.run, "--decision", "dismiss", "--note", "Good enough."),
      ruled = await run.denken("rule", run.run, "--decision", "dismiss", "--identities", "src.txt::c", "--note", "c is a preference."),
      state = await run.state(),
      end = await run.drive(),
      calls = await run.calls();
    assert.equal(textAt(stalled, "reason"), "stalled");
    assert.equal(blanket.status, FAILED);
    assert.match(textAt(blanket.json, "error"), /--identities/u);
    assert.equal(textAt(ruled.json, "action"), "ruled");
    assert.equal(textAt(state, "stage"), "plan");
    assert.ok(calls.includes("claude plan-methode-4 rw"), textAt(end, "action"));
  },
  bothDismissed = async (): Promise<void> => {
    const run = await setup(STALLING),
      stalled = await started(run),
      ruled = await run.denken("rule", run.run, "--decision", "dismiss", "--identities", "src.txt::c,other.txt::d", "--note", "Both are preferences."),
      state = await run.state();
    assert.equal(textAt(stalled, "reason"), "stalled");
    assert.equal(textAt(ruled.json, "action"), "ruled");
    assert.equal(textAt(state, "stage"), "dev");
    assert.equal(listAt(state, "deferred").filter((deferred) => textAt(deferred, "severity") === "dismissed").length, BOTH);
  },
  renamedTopic = async (): Promise<void> => {
    const run = await setup({
        "dev-ubel-1": changes(finding("error handling timeout")),
        "dev-ubel-2": changes(finding("timeout error handling logic")),
        "dev-ubel-3": changes(finding("handling-timeout-errors")),
      }),
      end = await started(run);
    assert.equal(textAt(end, "reason"), "topic_repeated");
    assert.equal(textAt(end, "identity"), "src.txt::error-handling-timeout");
    assert.equal(listAt(end, "occurrences").length, RAISED);
  };

await test("a stage-wide ruling must name each finding it dismisses", async () => {
  await oneDismissed();
  await bothDismissed();
});
await test("a slightly renamed topic on the same file counts as the same topic", renamedTopic);
