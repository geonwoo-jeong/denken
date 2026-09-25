// A started run in the record: the roles it runs with, the split into units if there is one, and its first stage.
import { agentLabel, roleAgents } from "./levels.ts";
import { entriesOf, hasItems } from "./lists.ts";
import type { RunStore } from "./types-store.ts";
import { UNITS } from "./paths.ts";
import type { UnitsCheck } from "./types-units.ts";
import { assertLock } from "./lock.ts";
import { createUnits } from "./units-create.ts";
import { enterStage } from "./stages.ts";
import { logRequest } from "./record-files.ts";
import { timeline } from "./record-log.ts";

const rolesText = (store: RunStore): string =>
    entriesOf(roleAgents(store.current()))
      .map(([role, agent]) => `${role.toUpperCase()}=${agentLabel(agent)}`)
      .join(" · "),
  recordStart = async (store: RunStore, split: UnitsCheck): Promise<void> => {
    await logRequest(store);
    await timeline(store, "DENKEN", `the user agreed the request; run started (${rolesText(store)}) → 00-request/request.md`);
    if (hasItems(split.units)) {
      await timeline(store, "DENKEN", `the request is split into ${split.units.length} units, built in parallel: ${split.units.map((unit) => `${unit.id} (${unit.reqs.join(", ")}) in ${unit.scope.join(", ")}`).join("; ")} → 00-request/${UNITS}`);
      await createUnits(store, split.units);
      store.apply({ stage: "units" });
    } else {
      await enterStage(store, "plan");
    }
    await assertLock();
  };

export { recordStart };
