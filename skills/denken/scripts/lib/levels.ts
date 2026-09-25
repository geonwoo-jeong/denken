/*
 * Levels: which model and effort each role runs with in this run. DENKEN picks a level per stage
 * (or role) by the task's difficulty, to spend tokens where they matter: light, standard (each role
 * as configured) or heavy. The config says what a level means on each provider. An explicit
 * --model or --effort for a role wins over its level.
 */
import type { Agent, Level, LevelSpec, Provider } from "./types-config.ts";
import type { Role, Stage } from "./types-names.ts";
import { framed, groupOf } from "./text.ts";
import type { CallSpec } from "./types-items.ts";
import { EFFORTS } from "./config-defaults.ts";
import type { Override } from "./types-progress.ts";
import type { RunState } from "./types-run.ts";
import { isStage } from "./stage-table.ts";

const STAGE_ROLES: Readonly<Record<Stage, readonly Role[]>> = {
    dev: ["stark", "ubel"],
    plan: ["methode", "richter"],
    qa: ["genau"],
    wiki: ["serie", "frieren"],
  },
  ROLE_NAMES: readonly Role[] = ["methode", "richter", "stark", "ubel", "genau", "serie", "frieren"],
  /*
   * Savings come from the workers. A checker (the reviewers and GENAU) never runs below standard,
   * nor below the level of the worker whose work it checks: a weak checker is where quality is lost.
   */
  RANK: Readonly<Record<Level, number>> = { heavy: 2, light: 0, standard: 1 },
  CHECKS: Readonly<Partial<Record<Role, Role>>> = { frieren: "serie", genau: "stark", richter: "methode", ubel: "stark" },
  // The checkers in the order their problems are reported.
  CHECK_ORDER: readonly Role[] = ["richter", "ubel", "frieren", "genau"],
  NO_SPEC: LevelSpec = { effort: "", model: "" },
  NO_OVERRIDE: Override = { effort: "", model: "" },
  FAMILY = /(?:^|claude-)(?<family>opus|sonnet|haiku|fable)\b/u,
  isRole = (key: string): key is Role => ROLE_NAMES.some((role) => role === key),
  // A stage's roles, or one role; none for anything else.
  rolesOf = (key: string): readonly Role[] => {
    if (isStage(key)) {
      return STAGE_ROLES[key];
    }
    if (isRole(key)) {
      return [key];
    }
    return [];
  },
  isChecker = (role: Role): boolean => typeof CHECKS[role] === "string",
  // The level of the worker a checker checks; the lowest for a worker, which checks nothing.
  checkedLevel = (state: RunState, role: Role): Level => {
    const checked = CHECKS[role];
    if (typeof checked === "string") {
      return state.levels[checked] ?? "standard";
    }
    return "light";
  },
  levelOf = (state: RunState, role: Role): Level => {
    const own = state.levels[role] ?? "standard",
      floor = checkedLevel(state, role);
    if (RANK[floor] > RANK[own]) {
      return floor;
    }
    return own;
  },
  levelSpecOf = (state: RunState, provider: Provider, level: Level): LevelSpec => {
    if (level === "light") {
      return state.assignment.levels[provider].light;
    }
    if (level === "heavy") {
      return state.assignment.levels[provider].heavy;
    }
    return NO_SPEC;
  },
  // The agent a role runs as in this run: its configured agent, changed by its level, then by any explicit model or effort.
  effectiveAgent = (state: RunState, role: Role, base: Agent): Agent => {
    const level = levelOf(state, role),
      mapped = levelSpecOf(state, base.provider, level),
      own = state.overrides[role] ?? NO_OVERRIDE;
    return {
      effort: own.effort || mapped.effort || base.effort,
      level,
      model: own.model || mapped.model || base.model,
      network: base.network,
      provider: base.provider,
    };
  },
  // Every role's agent, in the order of the stages: METHODE, RICHTER, STARK, UBEL, GENAU, SERIE, FRIEREN.
  roleAgents = (state: RunState): Readonly<Record<Role, Agent>> => {
    const { stages } = state.assignment,
      agentAs = (role: Role, base: Agent): Agent => effectiveAgent(state, role, base),
      planning = { methode: agentAs("methode", stages.plan.worker), richter: agentAs("richter", stages.plan.reviewer) };
    return Object.assign(
      Object.assign(planning, { stark: agentAs("stark", stages.dev.worker), ubel: agentAs("ubel", stages.dev.reviewer) }, { genau: agentAs("genau", stages.qa.runner) }),
      { serie: agentAs("serie", stages.wiki.worker) },
      { frieren: agentAs("frieren", stages.wiki.reviewer) },
    );
  },
  // What a model string names: "opus" and "claude-opus-5-5" are the same model, so the separation checks compare families.
  modelFamily = (agent: Agent): string => {
    const model = (agent.model || "default").toLowerCase();
    if (agent.provider === "claude") {
      return groupOf(FAMILY, model, "family") || model;
    }
    return model;
  },
  sameAgent = (first: Agent, second: Agent): boolean =>
    first.provider === second.provider && modelFamily(first) === modelFamily(second) && first.effort === second.effort,
  effortProblems = (agents: Readonly<Record<Role, Agent>>): readonly string[] =>
    ROLE_NAMES.flatMap((role) => {
      const agent = agents[role];
      if (agent.effort && !EFFORTS[agent.provider].includes(agent.effort)) {
        return [`${role} runs on ${agent.provider}, whose effort is one of ${EFFORTS[agent.provider].join(", ")} (got ${agent.effort})`];
      }
      return [];
    }),
  sameProblems = (agents: Readonly<Record<Role, Agent>>): readonly string[] =>
    CHECK_ORDER.flatMap((checker) => {
      const worker = CHECKS[checker];
      if (typeof worker === "string" && sameAgent(agents[worker], agents[checker])) {
        return [`${checker} would be the same model and effort as ${worker}, whose work it checks: give ${checker} a different level, model or effort`];
      }
      return [];
    }),
  /*
   * Levels must not undo the separation: with one provider, a checker may not end up as the same
   * model and effort as the worker it checks, unless the user allowed it.
   */
  choiceProblems = (state: RunState): readonly string[] => {
    const agents = roleAgents(state);
    if (state.assignment.allowSameReviewer) {
      return effortProblems(agents);
    }
    return [...effortProblems(agents), ...sameProblems(agents)];
  },
  levelTag = (level: Level): string => {
    if (level === "standard") {
      return "";
    }
    return ` [${level}]`;
  },
  agentLabel = (agent: Agent): string => `${agent.provider}${framed(": ", [agent.model, agent.effort].filter(Boolean).join(", "), "")}${levelTag(agent.level)}`,
  baseAgent = (state: RunState, call: CallSpec): Agent => {
    const { stages } = state.assignment;
    if (call.mode === "qa" || call.stage === "qa") {
      return stages.qa.runner;
    }
    if (call.mode === "work") {
      return stages[call.stage].worker;
    }
    return stages[call.stage].reviewer;
  },
  agentFor = (state: RunState, call: CallSpec): Agent => effectiveAgent(state, call.role, baseAgent(state, call));

export { agentFor, agentLabel, CHECKS, choiceProblems, effectiveAgent, isChecker, isRole, levelOf, modelFamily, RANK, ROLE_NAMES, roleAgents, rolesOf, STAGE_ROLES };
