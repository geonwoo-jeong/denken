// A unit's own run, in its worktree: its state, started in the plan stage, with its record in the parent's.
import { entriesOf, patch } from "./lists.ts";
import { logDir, timeline } from "./record-log.ts";
import { ROOT } from "./paths.ts";
import type { RunState } from "./types-run.ts";
import type { UnitPlan } from "./types-units.ts";
import { enterStage } from "./stages.ts";
import { logRequest } from "./record-files.ts";
import { makeStore } from "./store.ts";
import { newRunState } from "./state-zero.ts";
import { now } from "./text.ts";

interface UnitStart {
  readonly base: string;
  readonly run: string;
  readonly unit: UnitPlan;
}

const ID_BLOCK = 100,
  childState = (parent: RunState, start: UnitStart): RunState =>
    patch(newRunState({ created: now(), log: logDir(parent), task: `${parent.task} · ${start.unit.id}` }), {
      assignment: parent.assignment,
      baseRef: start.base,
      idBase: start.unit.num * ID_BLOCK,
      // The levels DENKEN picked apply to every unit, unless the unit's own line changes them.
      levels: Object.fromEntries([...entriesOf(parent.levels), ...entriesOf(start.unit.levels)]),
      mainRoot: ROOT,
      overrides: parent.overrides,
      scope: start.unit.scope,
      seeding: parent.seeding,
      title: start.unit.title,
      unit: start.unit.id,
    }),
  startUnitRun = async (parent: RunState, start: UnitStart): Promise<void> => {
    const child = makeStore(start.run, childState(parent, start)),
      { unit } = start;
    await enterStage(child, "plan");
    await logRequest(child);
    await timeline(child, "DENKEN", `${unit.id} (${unit.reqs.join(", ")}) "${unit.title}" starts in its own worktree; scope ${unit.scope.join(", ")}`);
    await child.save();
  };

export { ID_BLOCK, startUnitRun };
