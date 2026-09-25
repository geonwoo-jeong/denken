/*
 * Units: step them all, and come back with whatever needs DENKEN. The confirmation gate is re-checked
 * on every step, since DENKEN may replan a unit while the others wait there.
 */
import type { Action } from "./types-flow.ts";
import type { RunStore } from "./types-store.ts";
import type { StepOutcome } from "./types-units.ts";
import { actionFor } from "./flow-actions.ts";
import { assertLock } from "./lock.ts";
import { logStop } from "./record-stop.ts";
import { print } from "./output.ts";
import { stepUnits } from "./parallel-step.ts";

// What DENKEN is shown: a unit's action, or the run's own.
const shownOutcome = async (store: RunStore, outcome: StepOutcome): Promise<Action> => {
    if (outcome.kind === "action") {
      return outcome.action;
    }
    const action = await actionFor(store);
    return action;
  },
  // Returns whether the run moves on: true once the units are merged into the run.
  stepUnitsOnce = async (store: RunStore, deadline: number): Promise<boolean> => {
    const outcome = await stepUnits(store, deadline);
    await logStop(store);
    await assertLock();
    await store.save();
    if (outcome.kind === "merged") {
      return true;
    }
    print(await shownOutcome(store, outcome));
    return false;
  };

export { stepUnitsOnce };
