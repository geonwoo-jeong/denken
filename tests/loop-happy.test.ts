// DENKEN engine tests: the happy path. Shared setup is in helpers.ts.
import { changes, finding } from "./test-scenario.ts";
import { keysAt, textAt } from "./test-json.ts";
import assert from "node:assert/strict";
import { fileExists } from "./test-log.ts";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const HAPPY_CALLS: readonly string[] = [
    "claude plan-methode-1 rw",
    "codex plan-richter-1 ro",
    "claude plan-methode-2 rw",
    "codex plan-richter-2 ro",
    "codex dev-stark-1 rw",
    "claude dev-ubel-1 ro",
    "claude qa-genau-1 rw",
    "claude wiki-serie-1 rw",
    "codex wiki-frieren-1 ro",
  ],
  happyPath = async (): Promise<void> => {
    const run = await setup({ "plan-richter-1": changes(finding("scope", { file: "todo-dev.md" })) }),
      started = await run.denken("start", run.run),
      done = await run.drive(),
      state = await run.state();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done", JSON.stringify(done));
    assert.deepEqual(await run.calls(), HAPPY_CALLS);
    assert.ok(keysAt(state, "approved").every((stage) => textAt(state, "approved", stage)));
    assert.ok(await fileExists(path.join(run.proj, ".denken", ".gitignore")));
  };

await test("happy path alternates providers and reviewers run read-only", happyPath);
