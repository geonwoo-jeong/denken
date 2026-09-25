// Stopping units: a unit's own run (the _abort command), and every unit of a run aborted or split again.
import { SCRIPT, callBase } from "./paths.ts";
import { mapInOrder, patch } from "./lists.ts";
import { NO_CALL } from "./state-zero.ts";
import type { RunStore } from "./types-store.ts";
import type { UnitEntry } from "./types-progress.ts";
import { exists } from "./files.ts";
import { runProcess } from "./processes.ts";
import { stopCall } from "./call-stop.ts";
import { timeline } from "./record-log.ts";
import { unblock } from "./blocks.ts";

const stopInflight = async (store: RunStore): Promise<void> => {
    const { inflight } = store.current();
    if (inflight.kind === "none") {
      return;
    }
    await stopCall(callBase(store.dir, inflight.id), inflight.provider);
    store.apply({ inflight: NO_CALL });
  },
  // Stops a unit's run: its call, if one is running, and the run itself.
  stopUnitRun = async (store: RunStore): Promise<void> => {
    await stopInflight(store);
    store.apply({ stage: "aborted" });
    unblock(store);
    await timeline(store, "ENGINE", "stopped: the run it belongs to was aborted or split again");
    await store.save();
  },
  abortUnit = async (unit: UnitEntry): Promise<UnitEntry> => {
    if (unit.status === "done") {
      return unit;
    }
    if (await exists(unit.run)) {
      await runProcess(process.execPath, [SCRIPT, "_abort", unit.run], { cwd: unit.root });
    }
    return patch(unit, { status: "aborted" });
  },
  // A unit's run is stopped when the run it belongs to is aborted or split again.
  abortUnits = async (store: RunStore): Promise<void> => {
    store.apply({ units: await mapInOrder(store.current().units, abortUnit) });
  };

export { abortUnits, stopUnitRun };
