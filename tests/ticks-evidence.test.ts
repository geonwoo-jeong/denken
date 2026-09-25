// DENKEN engine tests: a tick needs evidence that names a file changed for the item. Shared setup is in helpers.ts.
import { changes, finding, qaItem } from "./test-scenario.ts";
import { gapsOf, logText, runText, startedRun } from "./plan-ticks-support.ts";
import { keysAt, textAt } from "./test-json.ts";
import assert from "node:assert/strict";
import { fileExists } from "./test-log.ts";
import path from "node:path";
import { test } from "node:test";

const FIRST_ITEM = 1,
  SECOND_ITEM = 2,
  NOT_TICKED: readonly string[] = ["DEV-001 is neither ticked off nor reported blocked in dev-report.md", "DEV-002 is neither ticked off nor reported blocked in dev-report.md"],
  // Evidence that names no changed file, or none at all, is refused, so nothing is ticked.
  refusedEvidence = async (evidence: string): Promise<void> => {
    const run = await startedRun({ "dev-stark-1": { evidence } }),
      end = await run.drive(),
      gaps = await gapsOf(run, "dev-stark-1"),
      logged = await fileExists(path.join(run.proj, run.run, "calls", "dev-stark-1.tick-DEV-001.log"));
    assert.equal(textAt(end, "action"), "done");
    assert.deepEqual(
      gaps.map((gap) => textAt(gap, "problem")),
      NOT_TICKED,
    );
    assert.ok(!logged);
  },
  // Names match whole: "a.js" does not name the changed a.jsx.
  wholeNames = async (): Promise<void> => {
    const run = await startedRun({ "dev-stark-1": { editFiles: { "a.jsx": "x\n" }, evidence: "changed a.js" } }),
      end = await run.drive(),
      ledger = await fileExists(path.join(run.proj, run.run, "calls", "dev-stark-1.ticks.jsonl"));
    assert.equal(textAt(end, "action"), "done");
    assert.ok(!ledger);
  },
  // A re-tick must name a file changed since the item's last tick: a.txt changed in round 1 only.
  retickSince = async (): Promise<void> => {
    const run = await startedRun({
        "dev-stark-1": { editFiles: { "a.txt": "x\n" }, evidence: "changed a.txt and src.txt" },
        "dev-stark-2": { evidence: "changed a.txt", tick: [FIRST_ITEM] },
        "dev-ubel-1": changes(finding("x")),
      }),
      end = await run.drive(),
      first = await fileExists(path.join(run.proj, run.run, "calls", "dev-stark-1.ticks.jsonl")),
      second = await fileExists(path.join(run.proj, run.run, "calls", "dev-stark-2.ticks.jsonl")),
      todo = await runText(run, "todo-dev.md");
    assert.equal(textAt(end, "action"), "done");
    assert.ok(first);
    assert.ok(!second);
    assert.match(todo, /DEV-001 \(REQ-001\) build one\n {2}Evidence: changed a\.txt and src\.txt\n/u);
  },
  noTickWithoutEvidence = async (): Promise<void> => {
    await Promise.all([refusedEvidence("did the work"), refusedEvidence(""), wholeNames(), retickSince()]);
  },
  forgedRecords = async (): Promise<void> => {
    const run = await startedRun({
        "dev-stark-1": {
          forgeTicks: [
            { evidence: "changed a.txt", item: "DEV-001" },
            { evidence: "changed src.txt", item: "DEV-009" },
          ],
          tick: [SECOND_ITEM],
        },
      }),
      end = await run.drive(),
      gaps = await gapsOf(run, "dev-stark-1"),
      timeline = await logText(run, "timeline.md"),
      state = await run.state();
    assert.equal(textAt(end, "action"), "done");
    assert.deepEqual(
      gaps.map((gap) => textAt(gap, "problem")),
      ["DEV-001's recorded tick was not accepted: its evidence names no file changed for it since development began"],
    );
    assert.match(timeline, /tick record\(s\) not accepted: DEV-001 \(its evidence names no file[^)]*\); DEV-009 \(it is not in the TODO section of todo-dev\.md\)/u);
    // The base of an applied tick comes from the engine, not from the record.
    assert.equal(textAt(state, "tickBases", "DEV-001", "call"), "dev-stark-2");
    assert.deepEqual(keysAt(state, "tickBases", "DEV-001", "tree"), ["src.txt"]);
  },
  noChangeNeeded = async (): Promise<void> => {
    const run = await startedRun({ "dev-stark-1": { noChange: { [SECOND_ITEM]: "DEV-001's change already covers it" } } }),
      end = await run.drive(),
      todo = await runText(run, "todo-dev.md"),
      prompt = await runText(run, "calls", "dev-ubel-1.prompt.md");
    assert.equal(textAt(end, "action"), "done");
    assert.match(todo, /DEV-002 \(REQ-002\) build two\n {2}Evidence: No change needed: DEV-001's change already covers it\n/u);
    assert.match(prompt, /Items ticked as needing no change: DEV-002 \(No change needed: DEV-001's change already covers it\)/u);
  },
  revertedFile = async (): Promise<void> => {
    const run = await startedRun({
        "dev-stark-1": { editFiles: { "a.txt": "broken\n" }, evidence: "changed a.txt and src.txt" },
        "dev-stark-2": { editFiles: { "a.txt": "a\n" }, fixEvidence: "reverted a.txt to its original content" },
        "qa-genau-1": { qa: { items: [qaItem(FIRST_ITEM), qaItem(SECOND_ITEM, "FAIL")], result: "FAIL" } },
      }),
      end = await run.drive(),
      fixes = await runText(run, "todo-fix.md");
    assert.equal(textAt(end, "action"), "done");
    assert.match(fixes, /- \[x\] FIX-001 [^\n]*\n {2}Evidence: reverted a\.txt to its original content\n/u);
  };

await test("no tick without evidence that names a file changed for the item", noTickWithoutEvidence);
await test("tick records are checked again when the call ends: a hand-written record is not applied", forgedRecords);
await test("an item that needs no change is ticked with its reason, which UBEL judges", noChangeNeeded);
await test("a recovery item that reverts a file can name it: evidence is measured from the QA cycle", revertedFile);
