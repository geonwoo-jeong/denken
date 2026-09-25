// DENKEN engine tests: how a request is split into units, what each unit may touch, and how DENKEN answers a unit.
import type { JsonObject, Ran, TestRun } from "./test-types.ts";
import { TWO_UNITS, changes, finding } from "./test-scenario.ts";
import { fileExists, readOr } from "./test-log.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";
import { writeFile } from "node:fs/promises";

const MAIN_WORKTREE = 1,
  OVERLAP = "- UNIT-1 (REQ-001) One. Scope: `a/`.\n- UNIT-2 (REQ-002) Two. Scope: `a/deep/`.\n",
  REPEATED = "- UNIT-1 (REQ-001, REQ-002) One. Scope: `a/`.\n- UNIT-2 (REQ-002, REQ-003) Two. Scope: `b/*`.\n",
  REPEATED_PROBLEMS: readonly RegExp[] = [
    /REQ-002 is in UNIT-1 and UNIT-2; each REQ item belongs to exactly one unit/u,
    /UNIT-2 names REQ-003, which request\.md does not define/u,
    /scope "b\/\*" must be a plain path/u,
  ],
  NAMING = changes(finding("naming", { file: "todo-dev.md" })),
  // A test project with folders a/ and b/, and DENKEN's split of the request in units.md.
  splitRun = async (scenario: JsonObject, units: string): Promise<TestRun> => {
    const run = await setup(scenario);
    await run.split(units);
    return run;
  },
  // Start again, after DENKEN rewrote units.md.
  restartWith = async (run: TestRun, units: string): Promise<Ran> => {
    await writeFile(path.join(run.proj, run.run, "units.md"), units);
    const started = await run.denken("start", run.run);
    return started;
  },
  verdictsOf = async (run: TestRun): Promise<string> => {
    const state = await run.state(),
      text = await readOr(path.join(run.proj, textAt(state, "log"), "verdicts.md"), "");
    return text;
  },
  splitRefused = async (): Promise<void> => {
    const run = await splitRun({}, OVERLAP),
      overlapped = await run.denken("start", run.run),
      repeated = await restartWith(run, REPEATED),
      worktrees = await run.worktrees();
    assert.match(textAt(overlapped.json, "error"), /UNIT-1 and UNIT-2 overlap at a\/ and a\/deep\/: work whose scope overlaps is not split\. Put it in one unit/u);
    for (const problem of REPEATED_PROBLEMS) {
      assert.match(textAt(repeated.json, "error"), problem);
    }
    assert.equal(worktrees, MAIN_WORKTREE);
  },
  staysInScope = async (): Promise<void> => {
    const run = await splitRun(
        {
          "UNIT-1:dev-stark-1": { editFiles: { "b/stray.txt": "x\n" } },
          "UNIT-1:dev-stark-2": { removeFiles: ["b/stray.txt"] },
          "UNIT-1:plan-methode-1": { devFiles: ["a/work.txt", "b/keep.txt"] },
        },
        TWO_UNITS,
      ),
      started = await run.denken("start", run.run),
      done = await run.drive(),
      verdicts = await verdictsOf(run);
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.match(verdicts, /· UNIT-1 · Planning check, round 1 · ENGINE · plan-methode-1 · \*\*RETURNED\*\* · DEV-101 names b\/keep\.txt, outside UNIT-1's scope \(a\/\)/u);
    assert.match(verdicts, /· UNIT-1 · Development check, round 1 · ENGINE · dev-stark-1 · \*\*RETURNED\*\* · b\/stray\.txt changed, outside UNIT-1's scope \(a\/\)/u);
    assert.ok(!(await fileExists(path.join(run.proj, "b", "stray.txt"))));
  },
  answeredWithUnit = async (): Promise<void> => {
    const run = await splitRun({ "UNIT-2:plan-richter-1": NAMING, "UNIT-2:plan-richter-2": NAMING, "UNIT-2:plan-richter-3": NAMING }, TWO_UNITS),
      started = await run.denken("start", run.run),
      blocked = await run.drive(),
      refused = await run.denken("rule", run.run, "--decision", "uphold", "--note", "x"),
      ruled = await run.denken("rule", run.run, "--unit", "UNIT-2", "--decision", "dismiss", "--note", "Naming is a preference."),
      done = await run.drive();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(blocked, "action"), "needs_ruling");
    assert.equal(textAt(blocked, "unit"), "UNIT-2");
    assert.match(textAt(blocked, "next"), /--unit UNIT-2/u);
    assert.match(textAt(refused.json, "error"), /the decisions are replan \(a new split\) or abort/u);
    assert.equal(textAt(ruled.json, "action"), "ruled");
    assert.equal(textAt(done, "action"), "done");
    assert.match(await verdictsOf(run), /· UNIT-2 · Ruling R1 on todo-dev\.md::naming · DENKEN · \*\*DISMISS\*\*/u);
  };

await test("units: a split whose scopes overlap, or that leaves out or repeats a REQ item, is refused", splitRefused);
await test("units: a unit plans and changes only inside its scope", staysInScope);
await test("units: what a unit needs from DENKEN comes through the parent, and is answered there with --unit", answeredWithUnit);
