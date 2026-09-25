// What DENKEN is shown while a run's units work: the joint confirmation, or what stopped the units.
import { REQUEST, ROOT, TODO_DEV, TODO_QA } from "./paths.ts";
import type { Action } from "./types-flow.ts";
import type { RunState } from "./types-run.ts";
import path from "node:path";
import { shownWith } from "./flow-view.ts";
import { stringsOf } from "./json.ts";
import { unitsSummary } from "./parallel-read.ts";

const confirmAction = (state: RunState, run: string): Action =>
    shownWith(state.blocked, {
      action: "needs_user",
      next: `Every unit has planned and passed its planning review. Show the user units.md and each unit's request.md and TODO lists. If they approve, run confirm ${run} --user-said '<their approval, verbatim>'. To change one unit's lists, run rule ${run} --unit <id> --decision replan --note '<the change>'. To change the split, edit units.md (and request.md), then run rule ${run} --decision replan --note '<why>'.`,
      run,
      units: state.units.map((unit) => ({
        files: [REQUEST, TODO_DEV, TODO_QA].map((name) => path.join(unit.run, name)),
        openQuestions: stringsOf(unit.last, "openQuestions"),
        reqs: unit.reqs,
        scope: unit.scope,
        title: unit.title,
        unit: unit.id,
      })),
    }),
  nextFor = (state: RunState, run: string): string => {
    const next: Readonly<Record<string, string>> = {
      main_tree_changed: `The project changed while the units were working, and they are merged into it. Show the user the status. When the project is as it should be, run retry ${run}; or abort with rule ${run} --decision abort.`,
      merge_conflict: `The units' changes did not apply together (${state.blocked.info.unit ?? ""}). Show the user the error and the patch. Run retry ${run} after the cause is fixed, or rule ${run} --decision abort.`,
      unit_aborted: `${state.blocked.info.unit ?? ""} was aborted, so the units cannot be merged. Ask the user, then run rule ${run} --decision abort, or rule ${run} --decision replan while the units wait for their first confirmation.`,
    };
    return next[state.blocked.reason] ?? "Tell the user, then run retry or rule --decision abort.";
  },
  unitsAction = (runDir: string, state: RunState): Action => {
    const run = path.relative(ROOT, runDir);
    if (state.blocked.reason === "confirm_todos") {
      return confirmAction(state, run);
    }
    return shownWith(state.blocked, { action: "needs_user", next: nextFor(state, run), run, units: unitsSummary(state.units) });
  };

export { unitsAction };
