// The actions of a finished run: done, with what DENKEN reports to the user, or aborted.
import { hasItems, mapAsync } from "./lists.ts";
import type { Action } from "./types-flow.ts";
import { ROOT } from "./paths.ts";
import type { RunState } from "./types-run.ts";
import type { UnitEntry } from "./types-progress.ts";
import { exists } from "./files.ts";
import path from "node:path";

const doneAction = (runDir: string, state: RunState): Action => ({
    action: "done",
    approved: state.approved,
    crossProvider: state.assignment.crossProvider,
    deferred: state.deferred.length,
    log: state.log,
    next: "Write summary.md from state.json and report to the user.",
    rulings: state.rulings.length,
    run: path.relative(ROOT, runDir),
    secrets: state.secretFindings,
    verdictsSha256: state.verdictsSha,
    warnings: state.assignment.warnings,
  }),
  rootExists = async (unit: UnitEntry): Promise<boolean> => {
    const found = await exists(unit.root);
    return found;
  },
  // An aborted run's units' worktrees are kept for inspection, as long as they are there.
  abortedAction = async (runDir: string, state: RunState): Promise<Action> => {
    const present = await mapAsync(state.units, rootExists),
      worktrees = state.units.filter((_unit, index) => present[index] === true).map((unit) => unit.root),
      action = { action: "aborted", rulings: state.rulings.length, run: path.relative(ROOT, runDir) };
    if (hasItems(state.units)) {
      return Object.assign(action, { worktrees });
    }
    return action;
  };

export { abortedAction, doneAction };
