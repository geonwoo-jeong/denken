// DENKEN engine tests: a call that fails, hits a usage limit, or answers outside its schema.
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const TWO_ATTEMPTS = 2,
  start = async (run: TestRun): Promise<TestRun> => {
    await run.denken("start", run.run);
    return run;
  },
  failedTwice = async (): Promise<void> => {
    const run = await start(await setup({ "plan-methode-1": [{ fail: "boom" }, { fail: "boom" }] })),
      blocked = await run.drive(),
      calls = await run.calls();
    assert.equal(textAt(blocked, "reason"), "call_failed");
    assert.equal(calls.length, TWO_ATTEMPTS);
  },
  usageLimit = async (): Promise<void> => {
    const run = await start(await setup({ "plan-methode-1": [{ fail: "Error: usage limit reached, try again at 5pm" }, {}] })),
      blocked = await run.drive(),
      resumed = await run.denken("retry", run.run),
      done = await run.drive();
    assert.equal(textAt(blocked, "reason"), "usage_limit");
    assert.equal(textAt(resumed.json, "action"), "resumed");
    assert.equal(textAt(done, "action"), "done");
  },
  failuresAndLimits = async (): Promise<void> => {
    await failedTwice();
    await usageLimit();
  },
  schemaRetry = async (): Promise<void> => {
    const run = await start(await setup({ "plan-richter-1": [{ review: { findings: [] } }, {}] })),
      done = await run.drive(),
      calls = await run.calls();
    assert.equal(textAt(done, "action"), "done");
    assert.equal(calls.filter((call) => call.includes("plan-richter-1")).length, TWO_ATTEMPTS);
  };

await test("a failed call is retried once, then blocks; usage limits block immediately", failuresAndLimits);
await test("output that does not match the schema is retried", schemaRetry);
