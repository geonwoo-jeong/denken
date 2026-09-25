// DENKEN engine tests: levels changed mid-run, and a unit's own levels. Shared setup is in helpers.ts.
import { argsLine, logText } from "./models-support.ts";
import { at, listAt, textAt } from "./test-json.ts";
import { changes, finding } from "./test-scenario.ts";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const UNITS_WITH_LEVELS = "- UNIT-1 (REQ-001) One. Scope: `a/`. Levels: dev=heavy.\n- UNIT-2 (REQ-002) Two. Scope: `b/`.\n",
  checkLevelsSet = async (project: TestRun): Promise<void> => {
    const unexplained = await project.denken("levels", project.run, "dev=heavy"),
      set = await project.denken("levels", project.run, "dev=heavy", "--note", "The loop keeps failing on the same point; give it a stronger model.");
    assert.match(textAt(unexplained.json, "error"), /say why/u);
    assert.equal(textAt(set.json, "action"), "levels");
  },
  checkRecorded = async (project: TestRun): Promise<void> => {
    const verdicts = await logText(project, "verdicts.md");
    assert.match(await argsLine(project, "qa-genau-1"), /--model opus --effort high/u);
    assert.match(
      verdicts,
      /· Levels · DENKEN · \*\*SET\*\* · STARK codex → codex: high \[heavy\]; UBEL claude → claude: opus, high \[heavy\]; GENAU claude → claude: opus, high \[heavy\]: The loop keeps failing/u,
    );
  },
  levelsMidRun = async (): Promise<void> => {
    const naming = changes(finding("naming")),
      project = await setup({ "dev-ubel-1": naming, "dev-ubel-2": naming, "dev-ubel-3": naming }),
      started = await project.denken("start", project.run),
      stopped = await project.drive();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(stopped, "reason"), "topic_repeated");
    await checkLevelsSet(project);
    await project.denken("rule", project.run, "--decision", "dismiss", "--note", "Naming is a preference.");
    assert.equal(textAt(await project.drive(), "action"), "done");
    await checkRecorded(project);
  },
  splitProject = async (units: string): Promise<TestRun> => {
    const project = await setup();
    await project.split(units);
    return project;
  },
  checkUnitArgs = async (project: TestRun): Promise<void> => {
    assert.match(await argsLine(project, "UNIT-1:dev-stark-1"), /model_reasoning_effort="high"/u);
    assert.doesNotMatch(await argsLine(project, "UNIT-2:dev-stark-1"), /model_reasoning_effort/u);
    assert.match(await argsLine(project, "UNIT-2:plan-methode-1"), /--model sonnet --effort low/u);
  },
  unitLevels = async (): Promise<void> => {
    const project = await splitProject(UNITS_WITH_LEVELS),
      started = await project.denken("start", project.run, "--level", "plan=light"),
      done = await project.drive();
    assert.deepEqual(
      listAt(started.json, "units").map((unit) => at(unit, "levels")),
      [{ stark: "heavy", ubel: "heavy" }, {}],
    );
    assert.equal(textAt(done, "action"), "done");
    await checkUnitArgs(project);
  };

await test("levels: DENKEN can change them mid-run, and the change is recorded", levelsMidRun);
await test("levels: a unit can carry its own levels", unitLevels);
