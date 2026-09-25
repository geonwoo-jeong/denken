// FLAMME's seeds: which seed a call forks, and the prompt FLAMME makes it with.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUEST, ROOT, sha, SKILL_DIR, TODO_DEV, TODO_QA } from "./core.mjs";
import { readRunFile } from "./state.mjs";
import { planText } from "./todo.mjs";

// ---------- FLAMME: seeds
// FLAMME, the seed AI, first gets to know the project (its layout, conventions, wiki and plan)
// and that context is kept as a seed session. Calls fork a seed, work, and are thrown away: every
// call starts from the same clean, loaded context, and on Claude, whose cache is keyed by content,
// even a role's first call reads the seed from the cache. There is a worker seed, a reviewer seed
// and a QA seed. Workers fork the worker seed, which never holds request.md, so STARK still sees
// only the development TODO; METHODE and SERIE get the request in their own message. Reviewers
// fork the reviewer seed, which holds the request; GENAU has its own, as it runs with other tools.
// The checkers' seeds serve every stage while code and docs change, so they hold where things are,
// never their content (roles/flamme.md): a checker judges the files as they are when it checks.
// A fork must match its seed's flags exactly to reuse the cache, so a seed's key also holds what
// shapes them (provider, model, effort, mode, network, grants, worktree). The engine alone keeps
// the seeds, in state.json.
export const PERSPECTIVE = { work: "worker", review: "reviewer", qa: "qa" };

// While METHODE plans, the development TODO is its own draft, not something to start from.
export const seedInputs = (perspective, stage) => ({ worker: stage === "plan" ? [] : [TODO_DEV], reviewer: [REQUEST], qa: [REQUEST, TODO_QA] })[perspective];

export const SEED_USE = { worker: "the workers who plan, build and document (METHODE, STARK, SERIE)", reviewer: "the reviewers who check plans, code and docs against the request (RICHTER, UBEL, FRIEREN)", qa: "GENAU, who verifies the product independently" };

// What shapes a call's flags: a fork or a continued session must match them to reuse the cache.
export function profileOf(state, call, agent) {
  const grants = call.mode === "review" ? null : state.grants?.[call.role] ?? null;
  return [agent.provider, agent.model ?? null, agent.effort ?? null, call.mode, Boolean(agent.network), grants, state.mainRoot ?? null];
}

// A seed is made again when what it read changes (ticks and evidence aside), and a Claude seed not
// used for close to the cache's hour is re-warmed first: its prefix would no longer be cached.
export const SEED_REWARM_MS = 55 * 60000;

export function seedFor(runDir, state, call, agent) {
  if (!(state.seeding ?? []).includes(agent.provider)) return null;
  const perspective = PERSPECTIVE[call.mode];
  const inputs = seedInputs(perspective, call.stage).map((f) => (f.startsWith("todo-") ? planText(readRunFile(runDir, f)) : readRunFile(runDir, f)));
  const profile = sha(JSON.stringify([...profileOf(state, call, agent), inputs])).slice(0, 12);
  const key = `${perspective}#${state.seedEpoch ?? 0}#${profile}`;
  const known = state.seedSessions?.[key];
  const idle = known ? Date.now() - Date.parse(known.lastUsedAt ?? known.at) : 0;
  return { key, perspective, sessionId: known?.sessionId ?? null, rewarm: agent.provider === "claude" && idle > SEED_REWARM_MS };
}

export function seedPrompt(runDir, state, call) {
  const perspective = PERSPECTIVE[call.mode];
  const answer = {
    review: `{"verdict": "CONTEXT_LOADED", "summary": "Reviewer context loaded.", "findings": [], "checked": [<the files you read>]}`,
    qa: `{"result": "CONTEXT_LOADED", "summary": "QA context loaded.", "items": []}`,
  }[call.mode];
  const inputs = seedInputs(perspective, call.stage).filter((f) => existsSync(join(runDir, f)));
  return [
    readFileSync(join(SKILL_DIR, "roles", "flamme.md"), "utf8").trimEnd(),
    "",
    "---",
    "",
    "## This seed",
    "",
    `- Stage: ${call.stage}`,
    `- Seed for: ${perspective}. Used by ${SEED_USE[perspective]}.`,
    `- Project root: ${ROOT}`,
    `- Run directory: ${runDir}`,
    `- Read:${inputs.length ? `\n${inputs.map((f) => `  - ${join(runDir, f)}`).join("\n")}` : " nothing from the run yet; the project itself"}`,
    ...(answer ? [`- This call answers in JSON; end with exactly: ${answer}`] : []),
    "",
  ].join("\n");
}
