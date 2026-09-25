// DENKEN engine tests: the timeline of a QA failure, its recovery, a permission stop and DENKEN's decision. Shared setup is in helpers.ts.
import type { JsonObject, TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { qaItem } from "./test-scenario.ts";
import { readOr } from "./test-log.ts";
import { readdir } from "node:fs/promises";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const FIRST = 1,
  SECOND = 2,
  START = 0,
  SCENARIO: JsonObject = {
    "dev-stark-2": [{ requestPermission: { need: "network", why: "fetch a fixture" } }, {}],
    "qa-genau-1": { qa: { items: [qaItem(FIRST), qaItem(SECOND, "FAIL")], result: "FAIL" } },
  },
  ORDER: readonly string[] = [
    "GENAU** · FAILED QA cycle 1: QA-002",
    "ENGINE** · recovery TODO FIX-001",
    "STARK** · asked for permission: network (fetch a fixture)",
    "STOP** · needs_permission",
    "DENKEN** · granted network (all hosts) to STARK",
    "RESUME** · dev-stark-2 runs again",
    "GENAU** · PASSED QA cycle 2",
  ],
  checkOrder = (timeline: string): void => {
    let from = START;
    for (const step of ORDER) {
      const index = timeline.indexOf(step, from);
      assert.ok(index >= from, `timeline out of order or missing: ${step}`);
      from = index;
    }
  },
  checkRecorded = async (run: TestRun): Promise<void> => {
    const done = await run.drive(),
      state = await run.state(),
      log = path.join(run.proj, textAt(state, "log")),
      timeline = await readOr(path.join(log, "timeline.md"), ""),
      development = await readdir(path.join(log, "02-development")),
      qa = await readdir(path.join(log, "03-qa"));
    assert.equal(textAt(done, "action"), "done");
    checkOrder(timeline);
    assert.ok(development.some((name) => name.endsWith("_engine-recovery-todo-qa1.md")));
    assert.ok(development.some((name) => name.endsWith("_denken-permission-P1-grant.md")));
    assert.deepEqual(qa.toSorted(), ["qa-1", "qa-2"]);
  },
  timelineOrder = async (): Promise<void> => {
    const run = await setup(SCENARIO),
      start = await run.denken("start", run.run),
      ask = await run.drive();
    assert.equal(textAt(start.json, "action"), "started");
    assert.equal(textAt(ask, "action"), "needs_permission");
    await run.denken("grant", run.run, "--network", "--user-said", "OK.", "--note", "The fixture host is trusted.");
    await checkRecorded(run);
  };

await test("the timeline records a QA failure, the recovery round, a permission stop and DENKEN's decision", timelineOrder);
