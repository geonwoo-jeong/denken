// DENKEN engine tests: only the engine writes ticks and evidence, and only METHODE words the TODO. Shared setup is in helpers.ts.
import { changes, finding } from "./test-scenario.ts";
import { runText, startedRun, textsAt } from "./plan-ticks-support.ts";
import type { JsonObject } from "./test-types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const FIRST_ITEM = 1,
  FAILURE = 1,
  WITH_NOTE =
    "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) one\n- [ ] DEV-002 (REQ-002) two\n- [ ] note: keep it small\n\n## Open questions\n- None\n",
  HAND_TICK: JsonObject = { "dev-stark-1": { tick: [], tickByHand: [FIRST_ITEM] } },
  HAND_EVIDENCE: JsonObject = {
    "dev-stark-2": { editTodo: [["Evidence: changed src.txt", "Evidence: rewrote the whole of src.txt"]], tick: [] },
    "dev-ubel-1": changes(finding("x")),
  },
  rewordedItem = async (): Promise<void> => {
    const run = await startedRun({ "dev-stark-1": { editTodo: [["build one", "build one, and a bit more"]] } }),
      stop = await run.drive(),
      todo = await runText(run, "todo-dev.md");
    assert.equal(textAt(stop, "reason"), "guard_violation");
    assert.match(textsAt(stop, "violations").join("\n"), /todo-dev\.md/u);
    assert.doesNotMatch(todo, /a bit more/u);
  },
  untickedByHand = async (): Promise<void> => {
    const run = await startedRun({ "dev-stark-2": { tick: [], untickByHand: [FIRST_ITEM] }, "dev-ubel-1": changes(finding("x")) }),
      stop = await run.drive(),
      todo = await runText(run, "todo-dev.md");
    assert.equal(textAt(stop, "reason"), "guard_violation");
    assert.equal(textAt(stop, "call"), "dev-stark-2");
    assert.match(todo, /- \[x\] DEV-001/u);
  },
  // A tick by hand, even of a real item, and an evidence line rewritten by hand.
  editedByHand = async (scenario: JsonObject): Promise<void> => {
    const run = await startedRun(scenario),
      stop = await run.drive(),
      todo = await runText(run, "todo-dev.md");
    assert.equal(textAt(stop, "reason"), "guard_violation");
    assert.doesNotMatch(todo, /rewrote/u);
  },
  otherBoxTicked = async (): Promise<void> => {
    const run = await startedRun({ "dev-stark-1": { tickOther: "note" }, "plan-methode-1": { todoDev: WITH_NOTE } }),
      stop = await run.drive();
    assert.equal(textAt(stop, "reason"), "guard_violation");
  },
  onlyEngineTicks = async (): Promise<void> => {
    await Promise.all([
      untickedByHand(),
      editedByHand(HAND_TICK),
      editedByHand(HAND_EVIDENCE),
      otherBoxTicked(),
    ]);
  },
  tickOutsideDev = async (): Promise<void> => {
    const run = await startedRun(),
      refused = await run.denken("tick", run.run, "DEV-001", "--", "true");
    assert.equal(refused.status, FAILURE);
    assert.match(textAt(refused.json, "error"), /only for STARK|for STARK, during a development call/u);
  };

await test("only METHODE words the TODO: STARK rewording an item is undone", rewordedItem);
await test("the engine is the only writer of ticks and evidence: any edit STARK makes to a TODO file is undone", onlyEngineTicks);
await test("the tick command refuses outside a development call", tickOutsideDev);
