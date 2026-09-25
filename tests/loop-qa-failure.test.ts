// DENKEN engine tests: a QA failure goes back to development, with a recovery TODO written from it.
import { at, textAt } from "./test-json.ts";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { qaItem } from "./test-scenario.ts";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const FIRST = 1,
  SECOND = 2,
  ONE_FAILURE = 1,
  MESSAGE_START = 0,
  MESSAGE_MAX = 600,
  AFTER_QA: readonly string[] = ["claude qa-genau-1 rw", "codex dev-stark-2 rw", "claude dev-ubel-2 ro", "claude qa-genau-2 rw", "claude wiki-serie-1 rw", "codex wiki-frieren-1 ro"],
  start = async (run: TestRun): Promise<TestRun> => {
    await run.denken("start", run.run);
    return run;
  },
  qaFailureGoesBack = async (): Promise<void> => {
    const run = await start(await setup({ "qa-genau-1": { qa: { items: [qaItem(FIRST), qaItem(SECOND, "FAIL")], result: "FAIL" } } })),
      end = await run.drive(),
      calls = await run.calls(),
      state = await run.state(),
      prompt = await readOr(path.join(run.proj, run.run, "calls", "dev-stark-2.prompt.md"), ""),
      todoFix = await readOr(path.join(run.proj, run.run, "todo-fix.md"), "");
    assert.equal(textAt(end, "action"), "done", JSON.stringify(end).slice(MESSAGE_START, MESSAGE_MAX));
    assert.deepEqual(calls.slice(calls.indexOf("claude qa-genau-1 rw")), AFTER_QA);
    assert.equal(at(state, "counts", "dev", "REQ-002"), ONE_FAILURE);
    // STARK gets a recovery TODO written from the failure, not the QA report or the QA TODO list.
    assert.match(prompt, /todo-fix\.md/u);
    assert.match(prompt, /recovery items FIX-001 under "QA cycle 1"/u);
    assert.doesNotMatch(prompt, /qa-genau-1\.out\.json|todo-qa\.md/u);
    assert.match(todoFix, /## QA cycle 1\n\n- \[x\] FIX-001 \(QA-002, REQ-002\) Fix: check 2\. Observed: boom\. Reproduce: npm test\./u);
  };

await test("QA failure sends work back to dev, which is reviewed again before QA reruns", qaFailureGoesBack);
