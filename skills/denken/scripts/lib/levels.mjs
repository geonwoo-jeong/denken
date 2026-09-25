// Levels: which model and effort each role runs with in this run.
import { EFFORTS, LEVELS } from "../config.mjs";
import { fail } from "./core.mjs";

// ---------- levels: the model each role uses in this run
// DENKEN picks a level per stage (or role) by the task's difficulty, to spend tokens where they
// matter: light, standard (each role as configured) or heavy. The config says what a level means
// on each provider. An explicit --model or --effort for a role wins over its level.
export const STAGE_ROLES = { plan: ["methode", "richter"], dev: ["stark", "ubel"], qa: ["genau"], wiki: ["serie", "frieren"] };

export const ROLE_NAMES = Object.values(STAGE_ROLES).flat();

export const rolesOf = (key) => STAGE_ROLES[key] ?? (ROLE_NAMES.includes(key) ? [key] : null);

// Savings come from the workers. A checker (the reviewers and GENAU) never runs below standard,
// nor below the level of the worker whose work it checks: a weak checker is where quality is lost.
export const RANK = { light: 0, standard: 1, heavy: 2 };

export const CHECKS = { richter: "methode", ubel: "stark", frieren: "serie", genau: "stark" };

export function levelOf(state, role) {
  const own = state.levels?.[role] ?? "standard";
  const worker = CHECKS[role] && (state.levels?.[CHECKS[role]] ?? "standard");
  return worker && RANK[worker] > RANK[own] ? worker : own;
}

// "--level plan=light" (a stage's roles, or one role), "--model stark=<id>", "--effort ubel=high";
// the levels command also takes bare "dev=heavy" pairs.
export function parseChoices(args, current = {}) {
  const levels = { ...current.levels };
  const overrides = JSON.parse(JSON.stringify(current.overrides ?? {}));
  const pairs = [];
  for (let i = 0; i < args.length; i++) {
    if (["--level", "--model", "--effort"].includes(args[i])) pairs.push([args[i].slice(2), args[++i]]);
    else if (args[i]?.startsWith("--")) i++;
    else if (/^[a-z]+=\S+$/.test(args[i] ?? "")) pairs.push(["level", args[i]]);
  }
  for (const [kind, pair] of pairs) {
    const [key, value] = String(pair ?? "").split("=");
    const roles = rolesOf(key);
    if (!roles || !value) fail(`--${kind} takes <stage or role>=<value>. Stages: ${Object.keys(STAGE_ROLES).join(", ")}; roles: ${ROLE_NAMES.join(", ")}`);
    if (kind === "level") {
      if (!LEVELS.includes(value)) fail(`a level is one of ${LEVELS.join(", ")} (got ${key}=${value})`);
      // "plan=light" makes the planner light; its reviewer stays at standard.
      if (value === "light" && roles.every((r) => CHECKS[r])) fail(`${key} checks other work (${roles.join(", ")}), and a checker never runs below standard`);
      for (const r of roles) if (!(value === "light" && CHECKS[r])) levels[r] = value;
    } else {
      if (kind === "model" && roles.length > 1) fail("--model names one role: a stage's worker and reviewer may run on different providers");
      for (const r of roles) (overrides[r] ??= {})[kind] = value;
    }
  }
  return { levels, overrides };
}

// The agent a role runs as in this run: its configured agent, changed by its level, then by any
// explicit model or effort DENKEN gave it.
export function effectiveAgent(state, role, base) {
  const level = levelOf(state, role);
  const mapped = level === "standard" ? {} : state.assignment.levels?.[base.provider]?.[level] ?? {};
  const own = state.overrides?.[role] ?? {};
  return { ...base, model: own.model ?? mapped.model ?? base.model, effort: own.effort ?? mapped.effort ?? base.effort, level };
}

export function roleAgents(state) {
  const agents = {};
  for (const [stage, roles] of Object.entries(STAGE_ROLES)) {
    const s = state.assignment.stages[stage];
    const bases = stage === "qa" ? [s.runner] : [s.worker, s.reviewer];
    roles.forEach((r, i) => (agents[r] = effectiveAgent(state, r, bases[i])));
  }
  return agents;
}

// Levels must not undo the separation: with one provider, a checker may not end up as the same
// model and effort as the worker it checks, unless the user allowed it.
export function choiceProblems(state) {
  const agents = roleAgents(state);
  const problems = [];
  for (const [r, a] of Object.entries(agents)) {
    if (a.effort != null && !EFFORTS[a.provider]?.includes(a.effort)) problems.push(`${r} runs on ${a.provider}, whose effort is one of ${EFFORTS[a.provider].join(", ")} (got ${a.effort})`);
  }
  const same = (a, b) => a.provider === b.provider && modelFamily(a) === modelFamily(b) && a.effort === b.effort;
  if (!state.assignment.allowSameReviewer) {
    for (const [checker, worker] of Object.entries(CHECKS)) {
      if (same(agents[worker], agents[checker])) problems.push(`${checker} would be the same model and effort as ${worker}, whose work it checks: give ${checker} a different level, model or effort`);
    }
  }
  return problems;
}

// What a model string names: "opus" and "claude-opus-5-5" are the same model, so the separation
// checks compare families, not strings. No model means the provider's default.
export function modelFamily(agent) {
  const m = String(agent.model ?? "default").toLowerCase();
  return agent.provider === "claude" ? m.match(/(?:^|claude-)(opus|sonnet|haiku|fable)\b/)?.[1] ?? m : m;
}

export const agentLabel = (a) => `${a.provider}${a.model || a.effort ? `: ${[a.model, a.effort].filter(Boolean).join(", ")}` : ""}${a.level && a.level !== "standard" ? ` [${a.level}]` : ""}`;

export function agentFor(state, call) {
  const s = state.assignment.stages[call.stage];
  return effectiveAgent(state, call.role, call.mode === "qa" ? s.runner : call.mode === "work" ? s.worker : s.reviewer);
}

// ---------- launching and executing calls
