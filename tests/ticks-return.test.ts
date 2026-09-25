// DENKEN engine tests: DEV items neither ticked nor reported blocked go straight back to STARK. Shared setup is in helpers.ts.
import { MISSING, at, textAt } from "./test-json.ts";
import { gapsOf, runText, startedRun } from "./plan-ticks-support.ts";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import { qaItem } from "./test-scenario.ts";
import { test } from "node:test";

const FIRST_ITEM = 1,
  SECOND_ITEM = 2,
  NEXT_CALLS = 3,
  FIRST_CYCLE = 1,
  BLOCKED_PLAN =
    "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) build one. Files: `lib/one.js`, `test/one.test.js`.\n- [ ] DEV-002 (REQ-002) build two. Files: `src.txt`.\n  - sub-note naming `lib/extra.js`\n\n## Open questions\n- None\n",
  identitiesOf = async (run: TestRun, call: string): Promise<readonly string[]> => {
    const gaps = await gapsOf(run, call);
    return gaps.map((gap) => textAt(gap, "identity"));
  },
  notTickedGoesBack = async (): Promise<void> => {
    const run = await startedRun({ "dev-stark-1": { tick: [FIRST_ITEM] } }),
      end = await run.drive(),
      calls = await run.calls(),
      from = calls.indexOf("codex dev-stark-1 rw"),
      gaps = await gapsOf(run, "dev-stark-1");
    assert.equal(textAt(end, "action"), "done");
    assert.deepEqual(calls.slice(from, from + NEXT_CALLS), ["codex dev-stark-1 rw", "codex dev-stark-2 rw", "claude dev-ubel-2 ro"]);
    assert.deepEqual(
      gaps.map((gap) => textAt(gap, "identity")),
      ["DEV-002"],
    );
  },
  blockedGoesToReview = async (): Promise<void> => {
    const run = await startedRun({
        "dev-stark-1": { report: "## TODO status\n- DEV-001 done\n- DEV-002 blocked: needs a design decision\n", tick: [FIRST_ITEM] },
        "plan-methode-1": { todoDev: BLOCKED_PLAN },
      }),
      end = await run.drive(),
      calls = await run.calls(),
      prompt = await runText(run, "calls", "dev-ubel-1.prompt.md");
    assert.equal(textAt(end, "action"), "done");
    assert.ok(calls.includes("claude dev-ubel-1 ro"));
    assert.match(prompt, /Items, evidence and recorded test runs: DEV-001 \[x\], evidence: "changed src\.txt", test `echo ok` exit 0 \(ok\), DEV-002 \[ \] reported blocked/u);
    assert.match(prompt, /Files changed in this stage: src\.txt/u);
    assert.match(prompt, /Changed files that no DEV item names: none/u);
    assert.match(prompt, /Ticked DEV items none of whose named files changed: DEV-001 \(lib\/one\.js, test\/one\.test\.js\)/u);
    assert.match(prompt, /Ticked DEV items with no named test file added or changed: DEV-001\./u);
  },
  unnamedChanges = async (): Promise<void> => {
    const run = await startedRun();
    await run.drive();
    assert.match(await runText(run, "calls", "dev-ubel-1.prompt.md"), /Changed files that no DEV item names: src\.txt\./u);
  },
  failedTestRun = async (): Promise<void> => {
    const run = await startedRun({ "dev-stark-1": { tickFail: [SECOND_ITEM] } }),
      end = await run.drive(),
      gaps = await gapsOf(run, "dev-stark-1"),
      log = await runText(run, "calls", "dev-stark-1.tick-DEV-002.log"),
      calls = await run.calls();
    assert.equal(textAt(end, "action"), "done");
    assert.deepEqual(
      gaps.map((gap) => [textAt(gap, "identity"), textAt(gap, "problem")]),
      [["DEV-002", "DEV-002 is neither ticked off nor reported blocked in dev-report.md"]],
    );
    assert.match(log, /\[exit 1\]/u);
    assert.ok(!calls.includes("claude dev-ubel-1 ro"));
  },
  // DEV-002 serves REQ-002 and was unticked; STARK's second round did not re-tick it with a test run.
  untickedAfterQa = async (): Promise<void> => {
    const run = await startedRun({ "dev-stark-2": { tick: [] }, "qa-genau-1": { qa: { items: [qaItem(FIRST_ITEM), qaItem(SECOND_ITEM, "FAIL")], result: "FAIL" } } });
    await run.drive();
    assert.deepEqual(await identitiesOf(run, "dev-stark-2"), ["DEV-002"]);
    assert.equal(at(await run.state(), "unticked", "DEV-002", "cycle"), FIRST_CYCLE);
    assert.equal(at(await run.state(), "unticked", "DEV-001"), MISSING);
  };

await test("a DEV item neither ticked off nor reported blocked goes straight back to STARK", notTickedGoesBack);
await test("a DEV item reported blocked goes to UBEL, who sees each item's status and the change scope", blockedGoesToReview);
await test("UBEL is told about changed files that no DEV item names", unnamedChanges);
await test("an item whose test run fails stays unticked and goes back to STARK", failedTestRun);
await test("after a QA failure the engine unticks the DEV items for the failing request item", untickedAfterQa);
