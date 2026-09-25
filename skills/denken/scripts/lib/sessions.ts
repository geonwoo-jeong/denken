/*
 * Workers continue their own session across rounds. A worker's next round in a stage continues its
 * previous round's session: it remembers what it did and why, and the cache still holds it (Codex
 * keys its cache by session, so only this reuses it). A session serves at most CONTINUE_ROUNDS
 * rounds; then the worker starts clean again, before the conversation grows long enough to crowd
 * out the plan. Checkers never continue: each review and QA round judges the work as it is now, not
 * anchored to the verdict it gave last time. A session is not continued when:
 * - its cache has likely expired: the whole grown conversation would be sent again, uncached, which
 *   costs more than a clean start;
 * - QA has failed again: the session holds its own case for the work QA keeps rejecting.
 */
import type { ContinuePlan, NoPlan } from "./types-call.ts";
import { NO_PLAN, SEED_REWARM_MS, profileOf } from "./seeds.ts";
import { TODO_DEV, TODO_FIX } from "./paths.ts";
import { entriesOf, hasItems } from "./lists.ts";
import { exists, modifiedAt } from "./files.ts";
import type { Agent } from "./types-config.ts";
import type { CallSpec } from "./types-items.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { sha } from "./text.ts";

const CONTINUE_ROUNDS = 3,
  FRESH_AFTER_CYCLE = 2,
  // The hash of a call's profile that a worker's session is kept with, and continued only under.
  sessionProfile = (state: RunState, call: CallSpec, agent: Agent): string => sha(profileOf(state, call, agent)),
  continues = (state: RunState, call: CallSpec, session: RunState["workSessions"][string]): boolean =>
    session.stage === call.stage &&
    session.epoch === state.seedEpoch &&
    session.chain < CONTINUE_ROUNDS &&
    !(Date.now() - Date.parse(session.at) > SEED_REWARM_MS) &&
    !(call.stage === "dev" && state.devInput === "qa" && state.currentFixCycle >= FRESH_AFTER_CYCLE),
  continueFor = (state: RunState, call: CallSpec, agent: Agent): ContinuePlan | NoPlan => {
    const previous = state.workSessions[call.role];
    if (call.mode !== "work" || !previous || previous.profile !== sessionProfile(state, call, agent) || !continues(state, call, previous)) {
      return NO_PLAN;
    }
    return { chain: previous.chain, from: previous.call, kind: "continue", sessionId: previous.sessionId, since: previous.at };
  },
  untickedLines = (state: RunState, since: string): readonly string[] => {
    const unticked = entriesOf(state.unticked)
      .filter(([, untick]) => untick.at > since)
      .map(([key, untick]) => `${key} (after QA cycle ${untick.cycle})`);
    if (hasItems(unticked)) {
      return [`the engine unticked ${unticked.join(", ")}: QA failed for the request items they serve`];
    }
    return [];
  },
  cycleLines = (state: RunState, since: string): readonly string[] =>
    entriesOf(state.fixCycles)
      .filter(([, cycle]) => cycle.at > since)
      .map(([cycle, fix]) => `QA cycle ${cycle} failed; the engine wrote ${fix.items.join(", ")} to ${TODO_FIX}`),
  tickLines = (call: CallSpec): readonly string[] => {
    if (call.stage === "dev") {
      return [`the engine wrote the ticks you recorded, with their evidence, into ${TODO_DEV}`];
    }
    return [];
  },
  rulingLines = (state: RunState, since: string): readonly string[] =>
    state.rulings.filter((ruling) => ruling.at > since).map((ruling) => `DENKEN's ruling ${ruling.id} (${ruling.decision}) on ${ruling.subject}: see rulings.md`),
  reviewLines = async (review: string, since: string): Promise<readonly string[]> => {
    if (!review || !(await exists(review))) {
      return [];
    }
    const changed = new Date(await modifiedAt(review)).toISOString();
    if (changed > since) {
      return ["a review of your last round came back; it is listed under Read"];
    }
    return [];
  },
  // What the engine and others did since the worker's session last ran, which its memory lacks.
  sinceLastCall = async (store: RunStore, call: CallSpec, since: string): Promise<readonly string[]> => {
    const state = store.current(),
      review = await reviewLines(state.lastReview[call.stage], since);
    return [...untickedLines(state, since), ...cycleLines(state, since), ...tickLines(call), ...rulingLines(state, since), ...review];
  };

export { CONTINUE_ROUNDS, continueFor, sessionProfile, sinceLastCall };
