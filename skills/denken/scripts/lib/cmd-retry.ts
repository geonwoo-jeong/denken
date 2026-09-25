// The retry command: the user resolved what stopped the run, and the call that stopped it runs again.
import { agentLabel, isRole, roleAgents } from "./levels.ts";
import { fail, print } from "./output.ts";
import type { RunStore } from "./types-store.ts";
import { STEP } from "./lists.ts";
import { assertLock } from "./lock.ts";
import { isStage } from "./stage-table.ts";
import { projectPrint } from "./guard-snapshot.ts";
import { timeline } from "./record-log.ts";
import { unblock } from "./blocks.ts";

const RESUMED = { action: "resumed", next: "Run next with --wait." },
  checkRetry = (store: RunStore): void => {
    const state = store.current(),
      { info } = state.blocked,
      role = info.role ?? "";
    if (state.blocked.kind !== "user") {
      fail("nothing to retry: the run is not waiting on the user");
    }
    if (info.resolveWith !== "retry") {
      fail(`this block is resolved with ${info.resolveWith ?? ""}, not retry`);
    }
    if (state.blocked.reason === "same_model_ran" && isRole(role) && agentLabel(roleAgents(state)[role]) === info.ranAs) {
      fail(`${role} would run the same way again (${info.ranAs ?? ""}); change it first with levels <run> ${role}=<level> --note '<why>' (or --model / --effort)`);
    }
  },
  // Units: the project as it is now becomes what they are merged into, and the merge is tried again.
  retryUnits = async (store: RunStore): Promise<void> => {
    const { reason } = store.current().blocked;
    unblock(store);
    store.apply({ mainPrint: await projectPrint(store.dir) });
    await timeline(store, "DENKEN", `retry after ${reason}`);
  },
  retryCall = async (store: RunStore): Promise<void> => {
    const { blocked, calls } = store.current(),
      id = blocked.info.call ?? "",
      [stage = "", role = "", round = ""] = id.split("-"),
      { mode } = calls.findLast((call) => call.id === id) ?? { mode: "work" };
    if (!isStage(stage) || !isRole(role)) {
      fail(`${id} is not a call of this run`);
    }
    unblock(store);
    store.apply({ retryCall: { attempt: STEP, kind: "retry", mode, role, round: Number(round), stage } });
    if (mode === "work") {
      store.apply({ pending: "work" });
    }
    await timeline(store, "DENKEN", `retry ${id} after ${blocked.reason}`);
  },
  resumeOf = (store: RunStore): ((store: RunStore) => Promise<void>) => {
    if (store.current().stage === "units") {
      return retryUnits;
    }
    return retryCall;
  },
  cmdRetry = async (store: RunStore): Promise<void> => {
    checkRetry(store);
    await resumeOf(store)(store);
    await assertLock();
    await store.save();
    print(RESUMED);
  };

export { cmdRetry };
