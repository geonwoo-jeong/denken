// DENKEN engine tests: what a continued worker is told, and when it starts fresh instead. Shared setup is in helpers.ts.
import type { JsonObject, TestRun } from "./test-types.ts";
import { changes, finding, qaItem } from "./test-scenario.ts";
import { editState, hoursAgo, recordAt, runText, setIn, upholdUntilDone } from "./models-support.ts";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const START = 0,
  HEAD = 3,
  FRESH_HEAD = 2,
  FIRST_ATTEMPT = 1,
  SECOND_ATTEMPT = 2,
  QA_ONE = 1,
  QA_TWO = 2,
  IDLE_HOURS = 2,
  failingQa = (attempt: number): JsonObject => ({
    qa: { items: [qaItem(QA_ONE), qaItem(QA_TWO, "FAIL", { check: `check 2 attempt ${attempt}` })], result: "FAIL", summary: "fails" },
  }),
  headOf = async (project: TestRun, key: string, attempt: number): Promise<readonly string[]> => {
    const args = await project.argsOf(key, attempt);
    return args.slice(START, FRESH_HEAD);
  },
  // The first fix round continues STARK's session, and is told what the engine did meanwhile; after QA fails again, STARK starts clean.
  // A run through two failed QA cycles, every stop upheld, to the end.
  finishedRun = async (scenario: JsonObject): Promise<TestRun> => {
    const project = await setup(scenario);
    await project.denken("start", project.run);
    await upholdUntilDone(project, false);
    return project;
  },
  toldWhatChanged = async (): Promise<void> => {
    const project = await finishedRun({ "qa-genau-1": failingQa(FIRST_ATTEMPT), "qa-genau-2": failingQa(SECOND_ATTEMPT) }),
      second = await project.argsOf("dev-stark-2"),
      prompt = await runText(project, "calls", "dev-stark-2.prompt.md");
    assert.deepEqual(second.slice(START, HEAD), ["exec", "resume", "thread-dev-stark-1"]);
    assert.match(
      prompt,
      /Since then:\n {2}- the engine unticked DEV-002 \(after QA cycle 1\): QA failed for the request items they serve\n {2}- QA cycle 1 failed; the engine wrote FIX-001 to todo-fix\.md\n {2}- the engine wrote the ticks you recorded/u,
    );
    assert.deepEqual(await headOf(project, "dev-stark-3", FIRST_ATTEMPT), ["exec", "--json"]);
  },
  // STARK's session was last used two hours ago.
  staleWorker = (state: JsonObject): JsonObject =>
    Object.assign(structuredClone(state), { workSessions: setIn(recordAt(state, "workSessions"), "stark", { key: "at", value: hoursAgo(IDLE_HOURS) }) }),
  // A session idle for about an hour is not continued: its cache would have expired.
  idleSession = async (): Promise<void> => {
    const project = await setup({ "dev-stark-2": [{ requestPermission: { need: "network", why: "a fixture" } }, {}], "dev-ubel-1": changes(finding("a")) }),
      started = await project.denken("start", project.run),
      stopped = await project.drive();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(stopped, "reason"), "needs_permission");
    await editState(project, staleWorker);
    await project.denken("grant", project.run, "--network", "--user-said", "Fine.", "--note", "Fixture.");
    assert.equal(textAt(await project.drive(), "action"), "done");
    assert.deepEqual(await headOf(project, "dev-stark-2", FIRST_ATTEMPT), ["exec", "resume"]);
    assert.deepEqual(await headOf(project, "dev-stark-2", SECOND_ATTEMPT), ["exec", "--json"]);
  },
  continuedOrFresh = async (): Promise<void> => {
    await toldWhatChanged();
    await idleSession();
  };

await test("a continued worker is told what changed since its last call; after a second QA failure, or an hour idle, it starts fresh", continuedOrFresh);
