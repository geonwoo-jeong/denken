// Whether the run stops or retries before a call's result is looked at: a guard violation, a permission request, a usage limit, or a failure.
import { agentLabel, roleAgents } from "./levels.ts";
import type { ActiveCall } from "./types-items.ts";
import type { Meta } from "./types-call.ts";
import type { RunStore } from "./types-store.ts";
import { askedForPermission } from "./ingest-permission.ts";
import { block } from "./blocks.ts";
import { callBase } from "./paths.ts";
import { increment } from "./lists.ts";
import { timeline } from "./record-log.ts";

const RETRIES = 2,
  failureReason = (meta: Meta): string => {
    if (meta.status === "timeout") {
      return "call_timeout";
    }
    return "call_failed";
  },
  // A failed call runs once more; a second failure needs the user.
  retryOrBlock = (store: RunStore, call: ActiveCall, meta: Meta): void => {
    if (call.attempt < RETRIES) {
      store.apply({ retryCall: { attempt: increment(call.attempt), kind: "retry", mode: call.mode, role: call.role, round: call.round, stage: call.stage } });
      return;
    }
    block(store, "user", { info: { call: call.id, error: meta.error, log: `${callBase(store.dir, call.id)}.log`, resolveWith: "retry" }, reason: failureReason(meta) });
  },
  guardStop = (store: RunStore, call: ActiveCall, meta: Meta): boolean => {
    if (meta.status !== "guard_violation") {
      return false;
    }
    block(store, "user", { info: { call: call.id, resolveWith: "retry", violations: meta.violations }, reason: "guard_violation" });
    return true;
  },
  usageStop = (store: RunStore, call: ActiveCall, meta: Meta): boolean => {
    if (meta.status !== "usage_limit") {
      return false;
    }
    block(store, "user", { info: { call: call.id, error: meta.error, log: `${callBase(store.dir, call.id)}.log`, provider: call.provider, resolveWith: "retry" }, reason: "usage_limit" });
    return true;
  },
  stopsHere = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<boolean> => {
    if (guardStop(store, call, meta) || (await askedForPermission(store, call, meta)) || usageStop(store, call, meta)) {
      return true;
    }
    if (meta.status === "ok") {
      return false;
    }
    retryOrBlock(store, call, meta);
    return true;
  },
  // The stage whose work a checker checks: GENAU checks development.
  checkedStage = (call: ActiveCall): string => {
    if (call.mode === "qa") {
      return "dev";
    }
    return call.stage;
  },
  /*
   * What actually ran can differ from what was asked for (an alias, an allowlist substituting a
   * model). A checker that ran as the same model and effort as the worker it checks is not accepted
   * as a check.
   */
  ranAsItsWorker = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<boolean> => {
    const state = store.current(),
      worker = state.lastWork[checkedStage(call)],
      ran = meta.facts.modelRan;
    if (state.assignment.allowSameReviewer || !ran || !worker || worker.modelRan !== ran || worker.provider !== call.provider || worker.effort !== meta.facts.effort) {
      return false;
    }
    await timeline(store, "ENGINE", `${call.role.toUpperCase()} ran as ${ran}, the same model and effort as the work it checks (${worker.call}); its result is not used`);
    block(store, "user", {
      info: { call: call.id, checked: worker.call, effort: meta.facts.effort, model: ran, ranAs: agentLabel(roleAgents(state)[call.role]), resolveWith: "retry", role: call.role },
      reason: "same_model_ran",
    });
    return true;
  };

export { ranAsItsWorker, stopsHere };
