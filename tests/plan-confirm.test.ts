// DENKEN engine tests: the user confirms the scope and TODO lists before development. Shared setup is in helpers.ts.
import { listAt, textAt } from "./test-json.ts";
import { runText, startedRun, textsAt } from "./plan-ticks-support.ts";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";

const FAILURE = 1,
  CONFIRMATIONS = 3,
  WITH_QUESTION =
    "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) one\n- [ ] DEV-002 (REQ-002) two\n\n## Open questions\n- Should errors be logged?\n",
  NO_CONFIRM = { autoConfirm: false },
  // Development waits at the gate; neither retry nor uphold gets past it.
  atTheGate = async (run: TestRun): Promise<void> => {
    const gate = await run.drive(NO_CONFIRM),
      calls = await run.calls(),
      retried = await run.denken("retry", run.run),
      upheld = await run.denken("rule", run.run, "--decision", "uphold", "--note", "x");
    assert.equal(textAt(gate, "action"), "needs_user");
    assert.equal(textAt(gate, "reason"), "confirm_todos");
    assert.deepEqual(
      textsAt(gate, "files").map((file) => path.basename(file)),
      ["request.md", "todo-dev.md", "todo-qa.md"],
    );
    assert.ok(!calls.some((call) => call.includes("dev-stark")));
    assert.equal(retried.status, FAILURE);
    assert.equal(upheld.status, FAILURE);
  },
  replanned = async (run: TestRun): Promise<void> => {
    const ruled = await run.denken("rule", run.run, "--decision", "replan", "--note", "The user wants DEV-002 split in two."),
      gate = await run.drive(NO_CONFIRM),
      calls = await run.calls(),
      prompt = await runText(run, "calls", "plan-methode-2.prompt.md");
    assert.equal(textAt(ruled.json, "action"), "ruled");
    assert.equal(textAt(gate, "reason"), "confirm_todos");
    assert.ok(calls.includes("claude plan-methode-2 rw"));
    assert.match(prompt, /rulings\.md/u);
  },
  confirmed = async (run: TestRun): Promise<void> => {
    const unsaid = await run.denken("confirm", run.run),
      said = await run.denken("confirm", run.run, "--user-said", "Yes, build it."),
      state = await run.state(),
      end = await run.drive();
    assert.equal(unsaid.status, FAILURE);
    assert.equal(textAt(said.json, "action"), "confirmed");
    assert.equal(textAt(state, "confirmed", "userSaid"), "Yes, build it.");
    assert.equal(textAt(end, "action"), "done");
  },
  waitsForConfirmation = async (): Promise<void> => {
    const run = await startedRun();
    await atTheGate(run);
    await replanned(run);
    await confirmed(run);
  },
  questionsOpen = async (run: TestRun): Promise<void> => {
    const gate = await run.drive(NO_CONFIRM),
      refused = await run.denken("confirm", run.run, "--user-said", "ok");
    assert.deepEqual(textsAt(gate, "openQuestions"), ["Should errors be logged?"]);
    assert.equal(refused.status, FAILURE);
    assert.match(textAt(refused.json, "error"), /open questions/u);
  },
  questionsAnswered = async (run: TestRun): Promise<void> => {
    await writeFile(path.join(run.proj, run.run, "request.md"), `${await runText(run, "request.md")}\n## Decisions\n- Should errors be logged? → No.\n`);
    await run.denken("rule", run.run, "--decision", "replan", "--note", "The user answered: errors are not logged.");
    const gate = await run.drive(NO_CONFIRM),
      said = await run.denken("confirm", run.run, "--user-said", "ok"),
      end = await run.drive();
    assert.deepEqual(listAt(gate, "openQuestions"), []);
    assert.equal(textAt(said.json, "action"), "confirmed");
    assert.equal(textAt(end, "action"), "done");
  },
  openQuestions = async (): Promise<void> => {
    const run = await startedRun({ "plan-methode-1": { todoDev: WITH_QUESTION } });
    await questionsOpen(run);
    await questionsAnswered(run);
  },
  // The request changes after confirmation: the run stops, and a confirmation alone does not resume it.
  requestChanged = async (run: TestRun, original: string): Promise<void> => {
    await writeFile(path.join(run.proj, run.run, "request.md"), original.replace("- OUT-001. Three.", "- OUT-001. Three.\n- OUT-002. Four."));
    const stop = await run.drive(NO_CONFIRM),
      calls = await run.calls(),
      refused = await run.denken("confirm", run.run, "--user-said", "Fine.");
    assert.equal(textAt(stop, "reason"), "scope_changed");
    assert.deepEqual(textsAt(stop, "changed"), ["request"]);
    assert.ok(!calls.some((call) => call.includes("dev-stark")));
    assert.match(textAt(refused.json, "error"), /no reviewer has checked the new content/u);
  },
  // Restoring what the user approved lets the run continue.
  restored = async (run: TestRun, original: string): Promise<void> => {
    await writeFile(path.join(run.proj, run.run, "request.md"), original);
    const again = await run.denken("confirm", run.run, "--user-said", "Approved again.");
    assert.equal(textAt(again.json, "action"), "confirmed");
  },
  // A change to the QA TODO alone can be approved directly.
  editQa = async (run: TestRun): Promise<void> => {
    const qa = await runText(run, "todo-qa.md");
    await writeFile(path.join(run.proj, run.run, "todo-qa.md"), qa.replace("check two", "check two, more carefully"));
  },
  qaChanged = async (run: TestRun): Promise<void> => {
    await editQa(run);
    const stop = await run.drive(NO_CONFIRM),
      said = await run.denken("confirm", run.run, "--user-said", "OK, the QA change is fine."),
      end = await run.drive(),
      state = await run.state();
    assert.deepEqual(textsAt(stop, "changed"), ["todoQa"]);
    assert.equal(textAt(said.json, "action"), "confirmed");
    assert.equal(textAt(end, "action"), "done");
    assert.equal(listAt(state, "confirmations").length, CONFIRMATIONS);
  },
  changedThenRestored = async (run: TestRun): Promise<void> => {
    const original = await runText(run, "request.md");
    await requestChanged(run, original);
    await restored(run, original);
    await qaChanged(run);
  },
  changeAfterConfirmation = async (): Promise<void> => {
    const run = await startedRun();
    await run.drive(NO_CONFIRM);
    await run.denken("confirm", run.run, "--user-said", "Approved.");
    await changedThenRestored(run);
  };

await test("development waits until the user confirms the TODO lists; a change request replans", waitsForConfirmation);
await test("open questions in the development TODO must be answered before development starts", openQuestions);
await test("a change after confirmation stops the run; request or dev TODO changes need a replan", changeAfterConfirmation);
