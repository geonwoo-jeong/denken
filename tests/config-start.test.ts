// DENKEN engine tests: what start refuses. Shared setup is in helpers.ts.
import type { Ran, TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";
import { writeFile } from "node:fs/promises";

const OK = 0,
  FAILED = 1,
  PARTIAL_REQUEST = "# Request\n\n## Confirmed\n- REQ-001. One. Done when: it works.\n",
  FULL_REQUEST = "# Request\n\n## Goal\nOne thing.\n\n## Confirmed\n- REQ-001. One. Done when: it works.\n\n## Out of scope\n- None\n\n## Not now\n- None\n\n## Cautions\n- None\n",
  sameReviewerRefused = async (): Promise<void> => {
    const run = await setup({}, { providers: ["codex"] }),
      refused = await run.denken("start", run.run),
      allowed = await run.node("config.ts", "set", "allowSameReviewer", "true"),
      started = await run.denken("start", run.run),
      done = await run.drive(),
      calls = await run.calls();
    assert.equal(refused.status, FAILED);
    assert.equal(textAt(refused.json, "reason"), "same_reviewer");
    assert.equal(allowed.status, OK);
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.ok(calls.every((call) => call.startsWith("codex")));
  },
  startWith = async (run: TestRun, request: string): Promise<Ran> => {
    await writeFile(path.join(run.proj, run.run, "request.md"), request);
    const started = await run.denken("start", run.run);
    return started;
  },
  incompleteRequest = async (): Promise<void> => {
    const run = await setup(),
      refused = await startWith(run, PARTIAL_REQUEST),
      started = await startWith(run, FULL_REQUEST);
    assert.equal(refused.status, FAILED);
    assert.match(textAt(refused.json, "error"), /## Goal[\s\S]*## Out of scope[\s\S]*## Not now[\s\S]*## Cautions/u);
    assert.equal(textAt(started.json, "action"), "started");
  };

await test("start refuses when the same model would check its own work, unless allowed", sameReviewerRefused);
await test("start refuses a request without its goal and every section", incompleteRequest);
