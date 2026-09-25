// DENKEN engine tests: a worker continues its own session across rounds; checkers start fresh. Shared setup is in helpers.ts.
import { changes, finding } from "./test-scenario.ts";
import { logText, runText, upholdUntilDone } from "./models-support.ts";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const START = 0,
  HEAD = 3,
  FRESH_HEAD = 2,
  FIRST_ATTEMPT = 1,
  SECOND_ATTEMPT = 2,
  ROUNDS_PER_STAGE = 6,
  REVIEWS: readonly string[] = ["dev-ubel-1", "dev-ubel-2", "dev-ubel-3", "dev-ubel-4"],
  headOf = async (project: TestRun, key: string, size: number): Promise<readonly string[]> => {
    const args = await project.argsOf(key);
    return args.slice(START, size);
  },
  // Codex continues STARK's thread in place, with the sandbox set explicitly; a session serves three rounds.
  checkThread = async (project: TestRun): Promise<void> => {
    const second = await project.argsOf("dev-stark-2");
    assert.deepEqual(second.slice(START, HEAD), ["exec", "resume", "thread-dev-stark-1"]);
    assert.ok(second.includes('sandbox_mode="workspace-write"') && !second.includes("-s"));
    assert.deepEqual(await headOf(project, "dev-stark-3", HEAD), ["exec", "resume", "thread-dev-stark-1"]);
    assert.deepEqual(await headOf(project, "dev-stark-4", FRESH_HEAD), ["exec", "--json"]);
  },
  // Its message holds only this call: the role and the earlier rounds are in the session.
  checkMessages = async (project: TestRun): Promise<void> => {
    const second = await runText(project, "calls", "dev-stark-2.prompt.md"),
      fourth = await runText(project, "calls", "dev-stark-4.prompt.md");
    assert.ok(second.startsWith("## This call\n\n- Role: STARK"));
    assert.match(second, /You continue your own session from dev-stark-1/u);
    assert.doesNotMatch(fourth, /You continue your own session/u);
  },
  // Reviewers never continue.
  checkReviewers = async (project: TestRun): Promise<void> => {
    const all = await Promise.all(
      REVIEWS.map(async (key) => {
        const args = await project.argsOf(key);
        return { args, key };
      }),
    );
    for (const review of all) {
      assert.ok(!review.args.includes("--resume"), review.key);
    }
  },
  checkRecord = async (project: TestRun): Promise<void> => {
    const timeline = await logText(project, "timeline.md"),
      step = await logText(project, "02-development", "03_stark-round2.md");
    assert.match(timeline, /STARK \(codex\)\*\* · started dev round 2, continuing its session from dev-stark-1/u);
    assert.match(step, /- Session: continued the session of dev-stark-1 \(round 2 in it\)/u);
  },
  continuesSession = async (): Promise<void> => {
    const project = await setup(
      { "dev-ubel-1": changes(finding("a")), "dev-ubel-2": changes(finding("b")), "dev-ubel-3": changes(finding("c")) },
      { limits: { roundsPerStage: ROUNDS_PER_STAGE } },
    );
    await project.denken("start", project.run);
    await upholdUntilDone(project, true);
    await checkThread(project);
    await checkMessages(project);
    await checkReviewers(project);
    await checkRecord(project);
  },
  startsFresh = async (): Promise<void> => {
    const project = await setup({ "dev-stark-2": [{ fail: "no session with that id" }, {}], "dev-ubel-1": changes(finding("a")) }),
      started = await project.denken("start", project.run),
      done = await project.drive(),
      first = await project.argsOf("dev-stark-2", FIRST_ATTEMPT),
      second = await project.argsOf("dev-stark-2", SECOND_ATTEMPT);
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.deepEqual(first.slice(START, FRESH_HEAD), ["exec", "resume"]);
    assert.deepEqual(second.slice(START, FRESH_HEAD), ["exec", "--json"]);
    assert.match(await logText(project, "timeline.md"), /ENGINE\*\* · STARK could not continue its session, and started fresh: continuing thread-dev-stark-1 failed/u);
  };

await test("a worker's later rounds continue its own session, up to three rounds; checkers always start fresh", continuesSession);
await test("a worker whose session cannot be continued starts fresh", startsFresh);
