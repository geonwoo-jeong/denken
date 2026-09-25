// What a ruling may do where the run stands: the confirmation takes only replan or abort, a replan needs a sound request, a dismissal names open findings.
import { hasItems, isEmpty, unique } from "./lists.ts";
import { requestProblems, reusedIds } from "./request.ts";
import { REQUEST } from "./paths.ts";
import type { RuleRequest } from "./types-rule.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import type { Stage } from "./types-names.ts";
import { fail } from "./output.ts";
import { isStage } from "./stage-table.ts";
import { readRunFile } from "./store.ts";

const stageOf = (state: RunState): Stage => {
    const stage = state.blocked.info.stage ?? state.stage;
    if (isStage(stage)) {
      return stage;
    }
    return "plan";
  },
  openIn = (state: RunState, stage: Stage): readonly string[] => unique(state.findings[stage].filter((finding) => finding.round === state.round[stage]).map((finding) => finding.identity)),
  checkReplan = async (store: RunStore, decision: string): Promise<void> => {
    const problems = [...requestProblems(await readRunFile(store.dir, REQUEST)), ...(await reusedIds(store))];
    if (decision === "replan" && hasItems(problems)) {
      fail(`fix request.md before replanning: ${problems.join("; ")}`);
    }
  },
  // Dismissals are per finding: a stage-wide ruling must name each identity it dismisses.
  checkDismiss = (state: RunState, request: RuleRequest): void => {
    const open = openIn(state, request.stage),
      identity = request.blocked.info.identity ?? "",
      unknown = request.targets.filter((target) => target !== identity && !open.includes(target));
    if (request.decision !== "dismiss") {
      return;
    }
    if (isEmpty(request.targets)) {
      fail(`name the findings to dismiss with --identities <a,b>. Open: ${open.join(", ") || "none"}`);
    }
    if (hasItems(unknown)) {
      fail(`not open in this stage: ${unknown.join(", ")}. Open: ${open.join(", ")}`);
    }
  },
  checkRuling = async (store: RunStore, request: RuleRequest): Promise<void> => {
    const confirming = request.blocked.reason === "confirm_todos" || request.blocked.reason === "scope_changed";
    if (confirming && request.decision !== "replan" && request.decision !== "abort") {
      fail("at the TODO confirmation, use confirm when the user approves, or rule --decision replan|abort");
    }
    await checkReplan(store, request.decision);
    checkDismiss(store.current(), request);
  };

export { checkRuling, stageOf };
