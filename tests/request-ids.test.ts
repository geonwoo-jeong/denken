// DENKEN engine tests: request ids are never reused once the user confirmed them. Shared setup is in helpers.ts.
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";
import { writeFile } from "node:fs/promises";

// The request file, and what it said when the user confirmed it.
interface Request {
  readonly file: string;
  readonly original: string;
}

const CONFIRMED_ITEM = "- REQ-002. Two. Done when: two works.",
  confirmedRun = async (): Promise<TestRun> => {
    const run = await setup();
    await run.denken("start", run.run);
    await run.drive({ autoConfirm: false });
    await run.denken("confirm", run.run, "--user-said", "Approved.");
    return run;
  },
  // A changed item under a number not used before is a new item: the replan goes ahead.
  renumbered = async (run: TestRun, request: Request): Promise<void> => {
    await writeFile(request.file, request.original.replace(CONFIRMED_ITEM, "- REQ-003. Two, faster. Done when: two works in 1s."));
    const ruled = await run.denken("rule", run.run, "--decision", "replan", "--note", "REQ-002 is replaced by REQ-003.");
    assert.equal(textAt(ruled.json, "action"), "ruled");
  },
  checkReused = async (run: TestRun, request: Request): Promise<void> => {
    const changed = await run.drive({ autoConfirm: false }),
      refused = await run.denken("rule", run.run, "--decision", "replan", "--note", "Faster.");
    assert.equal(textAt(changed, "reason"), "scope_changed");
    assert.match(textAt(refused.json, "error"), /REQ-002 now reads differently from what the user confirmed\. Ids are never reused/u);
    await renumbered(run, request);
  },
  idsNeverReused = async (): Promise<void> => {
    const run = await confirmedRun(),
      file = path.join(run.proj, run.run, "request.md"),
      original = await readOr(file, "");
    await writeFile(file, original.replace(CONFIRMED_ITEM, "- REQ-002. Two, faster. Done when: two works in 1s."));
    await checkReused(run, { file, original });
  };

await test("request ids are never reused: once confirmed, a changed item needs a new id", idsNeverReused);
