// DENKEN engine tests: what a call may not change, and how the run stops when it does.
import type { JsonValue, TestRun } from "./test-types.ts";
import { listAt, textAt } from "./test-json.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";

const SUCCESS = 0,
  FIRST_VIOLATION = 0,
  start = async (run: TestRun): Promise<TestRun> => {
    await run.denken("start", run.run);
    return run;
  },
  // The guard's violations, as text.
  violationsOf = (blocked: JsonValue | symbol): string =>
    listAt(blocked, "violations")
      .filter((item): item is string => typeof item === "string")
      .join("\n"),
  // Files git ignores, committed as such, with some of them already there.
  ignoring = async (run: TestRun, ignored: string, present: Readonly<Record<string, string>>): Promise<void> => {
    await writeFile(path.join(run.proj, ".gitignore"), ignored);
    await Promise.all(
      Object.keys(present).map(async (name) => {
        await writeFile(path.join(run.proj, name), present[name] ?? "");
      }),
    );
    await run.sh("git", "add", ".gitignore");
    await run.sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore");
  },
  reviewerEditsProject = async (): Promise<void> => {
    const run = await start(await setup({ "dev-ubel-1": [{ touch: "a.txt" }, {}] })),
      blocked = await run.drive(),
      restored = await run.sh("git", "checkout", "--", "a.txt"),
      resumed = await run.denken("retry", run.run),
      done = await run.drive();
    assert.equal(textAt(blocked, "action"), "needs_user");
    assert.equal(textAt(blocked, "reason"), "guard_violation");
    assert.match(textAt(blocked, "violations", FIRST_VIOLATION), /project files changed/u);
    assert.equal(restored.status, SUCCESS);
    assert.equal(textAt(resumed.json, "action"), "resumed");
    assert.equal(textAt(done, "action"), "done");
  },
  workerEditsState = async (): Promise<void> => {
    const run = await start(await setup({ "dev-stark-1": { touch: "$RUN/state.json" } })),
      blocked = await run.drive(),
      state = await run.state();
    assert.equal(textAt(blocked, "reason"), "guard_violation");
    assert.match(violationsOf(blocked), /DENKEN file changed: .*state\.json \(restored\)/u);
    assert.equal(textAt(state, "stage"), "dev");
  },
  reviewerEditsEnv = async (): Promise<void> => {
    const run = await setup({ "plan-richter-1": { touch: ".env" } });
    await ignoring(run, ".env\ncoverage.xml\n", { ".env": "SECRET=1\n", "coverage.xml": "<old/>\n" });
    await run.denken("start", run.run);
    assert.match(violationsOf(await run.drive()), /ignored file changed: \.env/u);
  },
  qaRewritesIgnored = async (): Promise<void> => {
    const run = await setup({ "qa-genau-1": { touch: "coverage.xml" } });
    await ignoring(run, "coverage.xml\n", { "coverage.xml": "<old/>\n" });
    await run.denken("start", run.run);
    assert.equal(textAt(await run.drive(), "action"), "done");
  },
  ignoredFiles = async (): Promise<void> => {
    await reviewerEditsEnv();
    await qaRewritesIgnored();
  },
  plannerEditsProject = async (): Promise<void> => {
    const run = await start(await setup({ "plan-methode-1": { touch: "a.txt" } })),
      blocked = await run.drive();
    assert.equal(textAt(blocked, "reason"), "guard_violation");
  };

await test("a reviewer that edits the project is rejected until the user resolves it", reviewerEditsProject);
await test("a worker that edits DENKEN's state is rejected", workerEditsState);
await test("a reviewer that edits an ignored .env file is rejected; QA may rewrite other ignored files", ignoredFiles);
await test("the planner may not change project files", plannerEditsProject);
