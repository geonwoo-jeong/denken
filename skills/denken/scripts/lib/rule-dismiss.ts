/*
 * A dismissal: the named findings are closed for the rest of the stage. When nothing blocking is left
 * open in the last round, the stage is approved; the dismissed findings are kept, marked as such, for
 * the summary.
 */
import { NONE, patch } from "./lists.ts";
import type { RuleRequest, Ruled } from "./types-rule.ts";
import { STAGE_NAME, verdict } from "./record-verdicts.ts";
import type { RunStore } from "./types-store.ts";
import { approve } from "./stage-approve.ts";

const closeTargets = (store: RunStore, request: RuleRequest): void => {
    const state = store.current(),
      { stage } = request,
      counts = Object.fromEntries([...Object.entries(state.counts[stage]), ...request.targets.map((target) => [target, NONE] as const)]);
    store.apply({
      counts: patch(state.counts, { [stage]: counts }),
      dismissed: patch(state.dismissed, { [stage]: [...state.dismissed[stage], ...request.targets] }),
    });
  },
  approveDismissed = async (store: RunStore, request: RuleRequest, ruled: Ruled): Promise<void> => {
    const state = store.current(),
      { stage } = request,
      lastRound = state.findings[stage].filter((finding) => finding.round === state.round[stage]);
    store.apply({ deferred: [...state.deferred, ...lastRound.map((finding) => patch(finding, { severity: "dismissed", stage }))] });
    await verdict(store, { file: ruled.file, label: `${STAGE_NAME[stage]} review`, note: `by ruling ${ruled.id}`, text: `no blocking finding is left open: ${request.targets.join(", ")} dismissed`, who: "DENKEN", word: "APPROVED" });
    await approve(store, stage, `${state.lastReview[stage]} + ruling ${ruled.id}`);
  },
  dismissFindings = async (store: RunStore, request: RuleRequest, ruled: Ruled): Promise<void> => {
    closeTargets(store, request);
    const state = store.current(),
      { stage } = request,
      dismissed = new Set(state.dismissed[stage]),
      lastRound = state.findings[stage].filter((finding) => finding.round === state.round[stage]);
    if (lastRound.every((finding) => dismissed.has(finding.identity)) && state.lastReview[stage]) {
      await approveDismissed(store, request, ruled);
    }
  };

export { dismissFindings };
