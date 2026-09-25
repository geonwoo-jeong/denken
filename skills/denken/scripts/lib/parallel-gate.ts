/*
 * What the units come to after a round: the project changed under them, a unit aborted, a unit
 * needs DENKEN, every unit waits for the first confirmation, or every unit is done and they merge.
 */
import { BLOCKED, WAIT } from "./step-outcomes.ts";
import { block, unblock } from "./blocks.ts";
import type { RunStore } from "./types-store.ts";
import type { StepOutcome } from "./types-units.ts";
import type { UnitEntry } from "./types-progress.ts";
import { lastText } from "./units-entries.ts";
import { mainChanged } from "./units-home.ts";
import { mergeUnits } from "./parallel-merge.ts";
import { unitAction } from "./parallel-read.ts";

// Before the first confirmation, every unit's TODO lists are confirmed together.
const gatedOf =
    (store: RunStore) =>
    (unit: UnitEntry): boolean =>
      !store.current().unitsConfirmed.at && lastText(unit, "reason") === "confirm_todos",
  // A unit that needs DENKEN for something other than the joint confirmation is shown on its own.
  needsDenken = (store: RunStore, unit: UnitEntry): StepOutcome => {
    if (store.current().blocked.reason === "confirm_todos") {
      unblock(store);
    }
    return { action: unitAction(store.dir, unit), kind: "action" };
  },
  allConfirming = (store: RunStore): StepOutcome => {
    if (store.current().blocked.reason !== "confirm_todos") {
      block(store, "user", { info: { resolveWith: "confirm", stage: "units" }, reason: "confirm_todos" });
    }
    return BLOCKED;
  },
  confirmGate = async (store: RunStore): Promise<StepOutcome> => {
    const { units, unitsConfirmed } = store.current(),
      gated = gatedOf(store),
      needs = units.find((unit) => unit.status === "waiting" && !gated(unit));
    if (needs) {
      return needsDenken(store, needs);
    }
    if (!unitsConfirmed.at && units.every((unit) => unit.status === "waiting" && gated(unit))) {
      return allConfirming(store);
    }
    if (units.every((unit) => unit.status === "done")) {
      const merged = await mergeUnits(store);
      return merged;
    }
    return WAIT;
  },
  unitGate = async (store: RunStore): Promise<StepOutcome> => {
    if (await mainChanged(store)) {
      return BLOCKED;
    }
    const aborted = store.current().units.find((unit) => unit.status === "aborted");
    if (aborted) {
      block(store, "user", { info: { resolveWith: "rule", stage: "units", unit: aborted.id }, reason: "unit_aborted" });
      return BLOCKED;
    }
    return confirmGate(store);
  };

export { unitGate };
