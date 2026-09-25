/*
 * The separation of workers and their checkers. With two providers the reviewer must be the other
 * one. With one, the same provider may review only if model or effort differ, or the user allowed it.
 */
import type { Agent, StageAgents } from "./types-config.ts";
import { REVIEWER, WORKER } from "./stage-table.ts";
import type { Separation } from "./types-partc.ts";
import type { WorkStage } from "./types-names.ts";
import { claudeNetworkHoles } from "./config-probe.ts";
import { hasItems } from "./lists.ts";

const PAIR_STAGES: readonly WorkStage[] = ["plan", "dev", "wiki"],
  same = (first: Agent, second: Agent): boolean => first.provider === second.provider && first.model === second.model && first.effort === second.effort,
  stageSeparation = (stages: StageAgents, stage: WorkStage, crossProvider: boolean): Separation => {
    const { reviewer, worker } = stages[stage];
    if (crossProvider && worker.provider === reviewer.provider) {
      return { errors: [`${stage}: ${WORKER[stage]} and ${REVIEWER[stage]} are both ${worker.provider}; the reviewer must use a different provider`], sameReviewer: [] };
    }
    if (same(worker, reviewer)) {
      return { errors: [], sameReviewer: [stage] };
    }
    return { errors: [], sameReviewer: [] };
  },
  qaSeparation = (stages: StageAgents, crossProvider: boolean): Separation => {
    const { runner } = stages.qa,
      { worker } = stages.dev;
    if (crossProvider && runner.provider === worker.provider) {
      return { errors: [`qa: genau and stark are both ${worker.provider}; QA must use a different provider`], sameReviewer: [] };
    }
    if (same(runner, worker)) {
      return { errors: [], sameReviewer: ["qa"] };
    }
    return { errors: [], sameReviewer: [] };
  },
  separationOf = (stages: StageAgents, crossProvider: boolean): Separation => {
    const checks = [...PAIR_STAGES.map((stage) => stageSeparation(stages, stage, crossProvider)), qaSeparation(stages, crossProvider)];
    return { errors: checks.flatMap((check) => check.errors), sameReviewer: checks.flatMap((check) => check.sameReviewer) };
  },
  checkerOf = (stage: string): string => {
    if (stage === "qa") {
      return "genau";
    }
    if (stage === "plan" || stage === "dev" || stage === "wiki") {
      return REVIEWER[stage];
    }
    return stage;
  },
  sameWarnings = (sameReviewer: readonly string[], allowSameReviewer: boolean): readonly string[] => {
    if (!hasItems(sameReviewer) || allowSameReviewer) {
      return [];
    }
    return [
      `the same model checks its own work in ${sameReviewer.join(", ")}; runs will not start until you give the reviewer (${sameReviewer.map((stage) => checkerOf(stage)).join(", ")}) a different model or effort, or set allowSameReviewer true`,
    ];
  },
  allAgents = (stages: StageAgents): readonly Agent[] => [stages.plan.worker, stages.plan.reviewer, stages.dev.worker, stages.dev.reviewer, stages.wiki.worker, stages.wiki.reviewer, stages.qa.runner],
  // Claude roles with network off can still reach the hosts Claude's own settings allow.
  holeWarnings = async (root: string, stages: StageAgents): Promise<readonly string[]> => {
    if (!allAgents(stages).some((agent) => agent.provider === "claude" && !agent.network)) {
      return [];
    }
    const holes = await claudeNetworkHoles(root);
    if (!hasItems(holes)) {
      return [];
    }
    return [`Claude roles with network off can still reach hosts your Claude settings allow: ${holes.join("; ")}`];
  };

export { holeWarnings, sameWarnings, separationOf };
