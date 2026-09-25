// The stages, who works and who checks in each, and what each worker writes.
import { DEV_REPORT, TODO_DEV, TODO_QA, WIKI_REPORT } from "./paths.ts";
import type { Role, RunStage, Stage, WorkStage } from "./types-names.ts";

const STAGES: readonly Stage[] = ["plan", "dev", "qa", "wiki"],
  WORK_STAGES: readonly WorkStage[] = ["plan", "dev", "wiki"],
  NEXT_STAGE: Readonly<Record<Stage, RunStage>> = { dev: "qa", plan: "dev", qa: "wiki", wiki: "done" },
  WORKER: Readonly<Record<WorkStage, Role>> = { dev: "stark", plan: "methode", wiki: "serie" },
  REVIEWER: Readonly<Record<WorkStage, Role>> = { dev: "ubel", plan: "richter", wiki: "frieren" },
  WORK_ARTIFACTS: Readonly<Record<WorkStage, readonly string[]>> = {
    dev: [DEV_REPORT],
    plan: [TODO_DEV, TODO_QA],
    wiki: [WIKI_REPORT],
  },
  PERMISSION_ASKS_PER_ROLE = 5,
  PERMISSION_ATTEMPTS_PER_CALL = 3,
  USAGE_LIMIT = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/iu,
  isStage = (value: string): value is Stage => value === "plan" || value === "dev" || value === "qa" || value === "wiki",
  isWorkStage = (value: string): value is WorkStage => value === "plan" || value === "dev" || value === "wiki",
  // What a stage's worker writes; QA has no worker artifacts.
  artifactsOf = (stage: string): readonly string[] => {
    if (isWorkStage(stage)) {
      return WORK_ARTIFACTS[stage];
    }
    return [];
  };

export {
  artifactsOf,
  isStage,
  isWorkStage,
  NEXT_STAGE,
  PERMISSION_ASKS_PER_ROLE,
  PERMISSION_ATTEMPTS_PER_CALL,
  REVIEWER,
  STAGES,
  USAGE_LIMIT,
  WORK_STAGES,
  WORKER,
};
