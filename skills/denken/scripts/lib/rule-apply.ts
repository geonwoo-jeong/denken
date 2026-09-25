/*
 * What a ruling does to the run: every ruling unblocks it and restarts the stage's counts toward
 * DENKEN; abort ends it, replan starts planning again from new seeds, and a dismissal closes the
 * findings it names, approving the stage when nothing blocking is left open.
 */
import { NONE, increment, patch, withEntry } from "./lists.ts";
import { NO_BLOCK, NO_CONFIRMATION } from "./state-zero.ts";
import type { RuleRequest, Ruled } from "./types-rule.ts";
import type { RunStore } from "./types-store.ts";
import { dismissFindings } from "./rule-dismiss.ts";
import { enterStage } from "./stages.ts";

// The ruled finding's count cleared and its identity marked ruled, from the state as it is now.
const markRuled = (store: RunStore, stage: RuleRequest["stage"], identity: string): void => {
    const state = store.current();
    store.apply({
      counts: patch(state.counts, { [stage]: withEntry(state.counts[stage], identity, NONE) }),
      ruled: patch(state.ruled, { [stage]: [...state.ruled[stage], identity] }),
    });
  },
  resetStage = (store: RunStore, request: RuleRequest): void => {
    const state = store.current(),
      { stage } = request,
      identity = request.blocked.info.identity ?? "";
    store.apply({
      blocked: NO_BLOCK,
      capBase: patch(state.capBase, { [stage]: state.round[stage] }),
      historyBase: patch(state.historyBase, { [stage]: state.history[stage].length }),
    });
    if (identity) {
      markRuled(store, stage, identity);
    }
  },
  replan = async (store: RunStore): Promise<void> => {
    // A new plan starts from new seeds.
    store.apply({ approved: { dev: "", plan: "", qa: "", wiki: "" }, confirmed: NO_CONFIRMATION, devInput: "", seedEpoch: increment(store.current().seedEpoch) });
    await enterStage(store, "plan");
  },
  applyRuling = async (store: RunStore, request: RuleRequest, ruled: Ruled): Promise<void> => {
    resetStage(store, request);
    if (request.decision === "abort") {
      store.apply({ stage: "aborted" });
    } else if (request.decision === "replan") {
      await replan(store);
    } else if (request.decision === "dismiss") {
      await dismissFindings(store, request, ruled);
    }
  };

export { applyRuling };
