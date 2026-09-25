// DENKEN engine tests: the engine checks the TODO lists and GENAU's report against the request. Shared setup is in helpers.ts.
import type { JsonObject, JsonValue, TestRun } from "./test-types.ts";
import { listAt, textAt } from "./test-json.ts";
import { logText, runText, startedRun } from "./plan-ticks-support.ts";
import assert from "node:assert/strict";
import { qaItem } from "./test-scenario.ts";
import { test } from "node:test";

const FIRST_CALLS = 3,
  START = 0,
  FIRST_ITEM = 1,
  SECOND_ITEM = 2,
  UNKNOWN_ITEM = 99,
  QA_ATTEMPTS = 2,
  GAPPED_DEV = "## Acceptance\n- REQ-001. One. Done when: one works!\n\n## TODO\n- [ ] DEV-001 (REQ-001) one\n- [ ] DEV-002 (OUT-001) three\n- DEV-003 (REQ-001) no checkbox\n",
  GAPPED_QA = "## Checks\n- [ ] QA-001 (REQ-001) one\n\n## Notes\n- QA-001 already covers REQ-001; this prose line is not an item.\n",
  GAP_IDENTITIES: readonly string[] = ["DEV-002", "REQ-002", "todo-copy-CAUTION-001", "todo-copy-LATER-001", "todo-copy-OUT-001", "todo-copy-REQ-001", "todo-copy-REQ-002", "todo-format-DEV-003"],
  CAUTION_DEV =
    "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001, CAUTION-001) one\n- [ ] DEV-002 (REQ-002) two\n\n## Open questions\n- None\n",
  CAUTION_QA = "## Checks\n- [ ] QA-001 (REQ-001) one\n- [ ] QA-002 (REQ-002) two\n- [ ] QA-003 (CAUTION-001) the change stays small\n",
  FAILED_QA: JsonObject = { "qa-genau-1": { qa: { items: [qaItem(FIRST_ITEM), qaItem(SECOND_ITEM, "FAIL")], result: "FAIL" } } },
  engineGaps = async (run: TestRun): Promise<readonly JsonValue[]> => {
    const state = await run.state();
    return listAt(state, "findings", "plan").filter((found) => textAt(found, "source") === "engine");
  },
  gappedLists = async (): Promise<void> => {
    const run = await startedRun({ "plan-methode-1": { todoDev: GAPPED_DEV, todoQa: GAPPED_QA } }),
      end = await run.drive(),
      calls = await run.calls(),
      gaps = await engineGaps(run),
      problems = gaps.map((gap) => textAt(gap, "problem"));
    assert.equal(textAt(end, "action"), "done");
    // No review was spent on the gapped lists.
    assert.deepEqual(calls.slice(START, FIRST_CALLS), ["claude plan-methode-1 rw", "claude plan-methode-2 rw", "codex plan-richter-2 ro"]);
    assert.deepEqual([...new Set(gaps.map((gap) => textAt(gap, "identity")))].toSorted(), GAP_IDENTITIES.toSorted());
    assert.ok(problems.includes("DEV-002 builds OUT-001, which the request puts out of scope"));
    assert.ok(problems.includes("REQ-001 in the Acceptance section of todo-dev.md differs from request.md"));
    assert.ok(!problems.some((problem) => problem.includes("QA-001")));
    assert.match(await runText(run, "calls", "plan-methode-2.prompt.md"), /plan-methode-1\.gaps\.json/u);
  },
  cautionsChecked = async (): Promise<void> => {
    const run = await startedRun({ "plan-methode-1": { todoDev: CAUTION_DEV, todoQa: CAUTION_QA } }),
      end = await run.drive(),
      calls = await run.calls();
    assert.equal(textAt(end, "action"), "done");
    assert.ok(!calls.includes("claude plan-methode-2 rw"));
  },
  missingFromReport = async (): Promise<void> => {
    const run = await startedRun({ "qa-genau-1": { qa: { items: [qaItem(FIRST_ITEM)], result: "PASS" } } }),
      end = await run.drive(),
      calls = await run.calls(),
      fixes = await runText(run, "todo-fix.md");
    assert.equal(textAt(end, "action"), "done");
    assert.ok(calls.includes("codex dev-stark-2 rw"));
    assert.match(fixes, /FIX-001 \(QA-002, REQ-002\) Fix: check two\. Observed: missing from the QA report\./u);
  },
  unknownItems = async (): Promise<void> => {
    const run = await startedRun({ "qa-genau-1": [{ qa: { items: [qaItem(FIRST_ITEM), qaItem(SECOND_ITEM), qaItem(UNKNOWN_ITEM, "FAIL")], result: "FAIL" } }, {}] }),
      end = await run.drive(),
      calls = await run.calls();
    assert.equal(textAt(end, "action"), "done");
    assert.equal(calls.filter((call) => call.includes("qa-genau-1")).length, QA_ATTEMPTS);
    assert.ok(!calls.includes("codex dev-stark-2 rw"));
  },
  drivenRun = async (scenario: JsonObject): Promise<TestRun> => {
    const run = await startedRun(scenario);
    await run.drive();
    return run;
  },
  generalFix = async (): Promise<void> => {
    const run = await drivenRun(FAILED_QA),
      prompt = await runText(run, "calls", "dev-ubel-2.prompt.md");
    assert.match(prompt, /todo-fix\.md/u);
    assert.match(prompt, /special-casing/u);
    assert.match(prompt, /FIX-001 \[x\], evidence: "fixed the cause in src\.txt", test `echo fixed` exit 0/u);
  },
  starkTicks = async (): Promise<void> => {
    const run = await startedRun(),
      end = await run.drive(),
      todo = await runText(run, "todo-dev.md"),
      calls = await run.calls(),
      step = await logText(run, "02-development", "01_stark-round1.md");
    assert.equal(textAt(end, "action"), "done");
    assert.match(todo, /- \[x\] DEV-001 \(REQ-001\) build one\n {2}Evidence: changed src\.txt\n/u);
    assert.match(todo, /- \[x\] DEV-002 \(REQ-002\) build two\n {2}Evidence: changed src\.txt\n/u);
    // Ticking is not a change to what the user confirmed.
    assert.ok(!calls.some((call) => call.includes("dev-stark-2")));
    // The step file shows the list as ticked, with the evidence.
    assert.match(step, /- \[x\] DEV-001 \(REQ-001\) build one\n {2}Evidence: changed src\.txt/u);
  };

await test("TODO lists with coverage gaps go straight back to METHODE, each gap with its own identity", gappedLists);
await test("a QA item may check a caution, and a DEV item may name the cautions it keeps", cautionsChecked);
await test("a QA item missing from the QA report counts as a failure", missingFromReport);
await test("a QA report with items that are not in todo-qa.md is rejected and retried", unknownItems);
await test("after a QA failure, the dev reviewer checks that the fix is general", generalFix);
await test("STARK ticks DEV items off in todo-dev.md, each with its evidence, and may change nothing else there", starkTicks);
