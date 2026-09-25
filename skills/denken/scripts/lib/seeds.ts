/*
 * FLAMME, the seed AI, first gets to know the project (its layout, conventions, wiki and plan) and
 * that context is kept as a seed session. Calls fork a seed, work, and are thrown away: every call
 * starts from the same clean, loaded context, and on Claude, whose cache is keyed by content, even a
 * role's first call reads the seed from the cache. There is a worker seed, a reviewer seed and a QA
 * seed. Workers fork the worker seed, which never holds request.md, so STARK still sees only the
 * development TODO; METHODE and SERIE get the request in their own message. Reviewers fork the
 * reviewer seed, which holds the request; GENAU has its own, as it runs with other tools. The
 * checkers' seeds serve every stage while code and docs change, so they hold where things are, never
 * their content (roles/flamme.md): a checker judges the files as they are when it checks. A fork must
 * match its seed's flags exactly to reuse the cache, so a seed's key also holds what shapes them
 * (provider, model, effort, mode, network, grants, worktree). The engine alone keeps the seeds, in
 * state.json.
 */
import type { NoPlan, SeedPlan } from "./types-call.ts";
import { REQUEST, TODO_DEV, TODO_QA } from "./paths.ts";
import { START, sha } from "./text.ts";
import type { Agent } from "./types-config.ts";
import type { CallSpec } from "./types-items.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { planText } from "./todo.ts";
import { readRunFile } from "./store.ts";
import { toLine } from "./json.ts";

// A seed session the run knows, if any.
type Known = RunState["seedSessions"][string] | undefined;

const MS_PER_MINUTE = 60_000,
  REWARM_MINUTES = 55,
  PROFILE_LENGTH = 12,
  NO_IDLE = 0,
  NO_PLAN: NoPlan = { kind: "none" },
  PERSPECTIVE: Readonly<Record<CallSpec["mode"], string>> = { qa: "qa", review: "reviewer", work: "worker" },
  /*
   * A seed is made again when what it read changes (ticks and evidence aside), and a Claude seed not
   * used for close to the cache's hour is re-warmed first: its prefix would no longer be cached.
   */
  SEED_REWARM_MS = REWARM_MINUTES * MS_PER_MINUTE,
  // While METHODE plans, the development TODO is its own draft, not something to start from.
  seedInputs = (perspective: string, stage: CallSpec["stage"]): readonly string[] => {
    if (perspective === "reviewer") {
      return [REQUEST];
    }
    if (perspective === "qa") {
      return [REQUEST, TODO_QA];
    }
    if (stage === "plan") {
      return [];
    }
    return [TODO_DEV];
  },
  grantsPart = (state: RunState, call: CallSpec): unknown => {
    if (call.mode === "review") {
      return "";
    }
    return state.grants[call.role] ?? "";
  },
  // What shapes a call's flags: a fork or a continued session must match them to reuse the cache.
  profileParts = (state: RunState, call: CallSpec, agent: Agent): readonly unknown[] => [
    agent.provider,
    agent.model,
    agent.effort,
    call.mode,
    agent.network,
    grantsPart(state, call),
    state.mainRoot,
  ],
  profileOf = (state: RunState, call: CallSpec, agent: Agent): string => toLine(profileParts(state, call, agent)),
  inputText = async (runDir: string, file: string): Promise<string> => {
    const text = await readRunFile(runDir, file);
    if (file.startsWith("todo-")) {
      return planText(text);
    }
    return text;
  },
  idleMs = (known: Known): number => {
    if (!known) {
      return NO_IDLE;
    }
    return Date.now() - Date.parse(known.lastUsedAt || known.at);
  },
  sessionOf = (known: Known): string => {
    if (!known) {
      return "";
    }
    return known.sessionId;
  },
  seedPlan = async (store: RunStore, call: CallSpec, agent: Agent): Promise<SeedPlan> => {
    const state = store.current(),
      perspective = PERSPECTIVE[call.mode],
      inputs = await Promise.all(
        seedInputs(perspective, call.stage).map(async (file) => {
          const text = await inputText(store.dir, file);
          return text;
        }),
      ),
      profile = sha(toLine([...profileParts(state, call, agent), inputs])).slice(START, PROFILE_LENGTH),
      key = `${perspective}#${state.seedEpoch}#${profile}`,
      known = state.seedSessions[key];
    return { key, kind: "seed", perspective, rewarm: agent.provider === "claude" && idleMs(known) > SEED_REWARM_MS, sessionId: sessionOf(known) };
  },
  seedFor = async (store: RunStore, call: CallSpec, agent: Agent): Promise<NoPlan | SeedPlan> => {
    if (!store.current().seeding.includes(agent.provider)) {
      return NO_PLAN;
    }
    const plan = await seedPlan(store, call, agent);
    return plan;
  };

export { NO_PLAN, PERSPECTIVE, profileOf, SEED_REWARM_MS, seedFor, seedInputs };
