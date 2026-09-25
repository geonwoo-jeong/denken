// DENKEN engine tests: the scope facts UBEL is given about the development stage. Shared setup is in helpers.ts.
import { mkdir, writeFile } from "node:fs/promises";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const TODO_DEV =
    "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) one. Files: `lib/`, `test/b.test.js`.\n- [ ] DEV-002 (REQ-002) two.\n\n## Open questions\n- None\n",
  SCENARIO = {
    "dev-stark-1": { editFiles: { "lib/x.js": "export const x = 1;\n", "test/b.test.js": "test.skip('one', () => {});\n" } },
    "plan-methode-1": { todoDev: TODO_DEV },
  },
  // A test file with two tests, committed before the run starts: STARK then deletes one and skips the other.
  started = async (): Promise<TestRun> => {
    const run = await setup(SCENARIO);
    await mkdir(path.join(run.proj, "test"));
    await writeFile(path.join(run.proj, "test", "b.test.js"), "test('one', () => {});\ntest('two', () => {});\n");
    await run.sh("git", "add", ".");
    await run.sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "tests");
    await run.denken("start", run.run);
    return run;
  },
  scopeFacts = async (): Promise<void> => {
    const run = await started(),
      done = await run.drive(),
      prompt = await readOr(path.join(run.proj, run.run, "calls", "dev-ubel-1.prompt.md"), "");
    assert.equal(textAt(done, "action"), "done");
    assert.match(prompt, /Changed files that no DEV item names: src\.txt\./u);
    assert.match(prompt, /Ticked DEV items that name no files: DEV-002\./u);
    assert.match(prompt, /Lines deleted from test files: test\/b\.test\.js \(2\)/u);
    assert.match(prompt, /Skip markers added: test\/b\.test\.js: test\.skip\('one', \(\) => \{\}\);/u);
  };

await test("UBEL is told about deleted test lines, added skip markers, and files under a named directory", scopeFacts);
