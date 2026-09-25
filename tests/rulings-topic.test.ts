// DENKEN engine tests: a topic raised again and again goes to DENKEN. Shared setup is in helpers.ts.
import { changes, finding } from "./test-scenario.ts";
import { listAt, textAt } from "./test-json.ts";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import { runText } from "./models-support.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const REPEATS = 3,
  checkRuling = async (project: TestRun): Promise<void> => {
    const ruling = await project.drive();
    assert.equal(textAt(ruling, "action"), "needs_ruling");
    assert.equal(textAt(ruling, "reason"), "topic_repeated");
    assert.equal(textAt(ruling, "identity"), "src.txt::error-handling");
    assert.equal(listAt(ruling, "occurrences").length, REPEATS);
  },
  checkUpheld = async (project: TestRun): Promise<void> => {
    const ruled = await project.denken("rule", project.run, "--decision", "uphold", "--note", "Handle the timeout case as the reviewer says."),
      done = await project.drive(),
      calls = await project.calls(),
      rulings = await runText(project, "rulings.md");
    assert.equal(textAt(ruled.json, "action"), "ruled");
    assert.equal(textAt(done, "action"), "done");
    assert.ok(calls.includes("codex dev-stark-4 rw"));
    assert.match(rulings, /R1 · dev · src\.txt::error-handling · uphold/u);
  },
  topicRepeated = async (): Promise<void> => {
    const project = await setup({
      "dev-ubel-1": changes(finding("error handling")),
      "dev-ubel-2": changes(finding("Error-Handling")),
      "dev-ubel-3": changes(finding("error-handling")),
    });
    await project.denken("start", project.run);
    await checkRuling(project);
    await checkUpheld(project);
  };

await test("a topic raised three times asks DENKEN for a ruling; uphold continues the loop", topicRepeated);
