// DENKEN engine tests: calls that misbehave: denied actions, timeouts, stray processes and stale results. Shared setup is in helpers.ts.
import type { JsonValue, TestRun } from "./test-types.ts";
import { changes, finding } from "./test-scenario.ts";
import { listAt, textAt } from "./test-json.ts";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const TWO_ATTEMPTS = 2,
  SLOW_MS = 5000,
  LATE_MS = 1500,
  AFTER_LATE_MS = 2000,
  // About 1.2 seconds: shorter than the slow call.
  TIMEOUT_MIN = 0.02,
  started = async (run: TestRun): Promise<JsonValue | symbol> => {
    await run.denken("start", run.run);
    const end = await run.drive();
    return end;
  },
  repeatedDenials = async (): Promise<void> => {
    const denial = { denials: [{ tool_input: { command: "curl example.com" }, tool_name: "Bash" }] },
      run = await setup({ "plan-methode-1": denial, "plan-methode-2": denial, "plan-richter-1": changes(finding("x", { file: "todo-dev.md" })) }),
      end = await started(run),
      prompt = await readFile(path.join(run.proj, run.run, "calls", "plan-richter-1.prompt.md"), "utf8");
    assert.equal(textAt(end, "reason"), "repeated_permission_denials");
    assert.match(prompt, /1 action\(s\) blocked/u);
  },
  timedOut = async (): Promise<void> => {
    const run = await setup({ "plan-methode-1": [{ sleepMs: SLOW_MS }, { sleepMs: SLOW_MS }] }, { limits: { callTimeoutMin: TIMEOUT_MIN } }),
      end = await started(run),
      calls = await run.calls();
    assert.equal(textAt(end, "action"), "needs_user");
    assert.equal(textAt(end, "reason"), "call_timeout");
    assert.equal(calls.length, TWO_ATTEMPTS);
  },
  strayStopped = async (): Promise<void> => {
    const run = await setup({ "plan-methode-1": { spawnLate: { afterMs: LATE_MS, touch: "a.txt" } } }),
      end = await started(run);
    assert.equal(textAt(end, "action"), "done");
    await delay(AFTER_LATE_MS);
    assert.equal(await readFile(path.join(run.proj, "a.txt"), "utf8"), "a\n");
  },
  staleResult = async (): Promise<void> => {
    const run = await setup({ "plan-methode-1": { staleMeta: true } }),
      end = await started(run),
      state = await run.state(),
      names = await readdir(path.join(run.proj, run.run, "calls"));
    assert.equal(textAt(end, "action"), "done");
    assert.deepEqual(
      listAt(state, "calls")
        .filter((call) => textAt(call, "id") === "plan-methode-1")
        .map((call) => textAt(call, "status")),
      ["ok"],
    );
    assert.ok(names.some((name) => /^plan-methode-1\.stale-\d+\.meta\.json$/u.test(name)));
  };

await test("repeated permission denials in work calls stop the run", repeatedDenials);
await test("a call that exceeds the timeout is retried once, then blocks", timedOut);
await test("processes an agent leaves running are stopped when its call ends", strayStopped);
await test("a result left by an earlier attempt of the same call is not taken as this attempt's", staleResult);
