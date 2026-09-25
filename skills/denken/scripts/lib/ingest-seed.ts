// What a finished call tells the run about FLAMME's seed it used or made, and the worker's own session.
import type { Meta, SeedMeta } from "./types-call.ts";
import { STEP, patch, withEntry, withoutEntry } from "./lists.ts";
import { hasTokens, isKnown } from "./call-zero.ts";
import { now, oneLine } from "./text.ts";
import type { ActiveCall } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { agentFor } from "./levels.ts";
import { sessionProfile } from "./sessions.ts";
import { timeline } from "./record-log.ts";

const FALLBACK_MAX = 200,
  count = (value: number): string => {
    if (isKnown(value)) {
      return String(value);
    }
    return "?";
  },
  tokensNote = (seed: SeedMeta): string => {
    const { tokens } = seed.facts;
    if (!hasTokens(tokens)) {
      return "";
    }
    return ` (in ${count(tokens.input)} · cache read ${count(tokens.cacheRead)} · out ${count(tokens.output)})`;
  },
  keepSeed = async (store: RunStore, call: ActiveCall, seed: SeedMeta): Promise<void> => {
    const [kind = ""] = seed.key.split("#"),
      { seedSessions } = store.current(),
      known = seedSessions[seed.key] ?? { at: now(), call: call.id, lastUsedAt: "", perspective: kind, provider: call.provider, sessionId: "", stage: call.stage },
      kept = patch(known, { lastUsedAt: now(), sessionId: seed.sessionId });
    store.apply({ seedSessions: withEntry(seedSessions, seed.key, kept) });
    if (seed.rewarmed) {
      await timeline(store, `FLAMME (${call.provider})`, `re-warmed the ${kind} seed, idle for close to an hour, before ${call.id} forked it`);
    }
  },
  noteCreated = async (store: RunStore, call: ActiveCall, seed: SeedMeta): Promise<void> => {
    const [kind = ""] = seed.key.split("#");
    await timeline(store, `FLAMME (${call.provider})`, `seeded the ${kind} context in the ${call.stage} stage, for ${call.id}${tokensNote(seed)}; calls with the same perspective and settings fork it`);
  },
  dropSeed = async (store: RunStore, call: ActiveCall, seed: SeedMeta): Promise<void> => {
    store.apply({ seedSessions: withoutEntry(store.current().seedSessions, seed.key) });
    await timeline(store, "ENGINE", `${call.role.toUpperCase()} ran without FLAMME's seed: ${oneLine(seed.fallback, FALLBACK_MAX)}`);
  },
  // FLAMME's seed for the call's kind, made by this call or used by it.
  noteSeed = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<void> => {
    const { seed } = meta;
    if (seed.kind === "none") {
      return;
    }
    if (!seed.fallback && seed.sessionId) {
      await keepSeed(store, call, seed);
    }
    if (seed.created && !seed.fallback) {
      await noteCreated(store, call, seed);
    }
    if (seed.fallback) {
      await dropSeed(store, call, seed);
    }
  },
  chainOf = (meta: Meta): number => {
    if (meta.continuation.kind === "continue" && !meta.continuation.fallback) {
      return meta.continuation.chain;
    }
    return STEP;
  },
  // A successful worker's session, for its next round to continue.
  noteSession = (store: RunStore, call: ActiveCall, meta: Meta): void => {
    const state = store.current(),
      profile = sessionProfile(state, call, agentFor(state, call));
    if (call.mode !== "work" || !meta.sessionId) {
      return;
    }
    store.apply({
      workSessions: withEntry(state.workSessions, call.role, {
        at: now(),
        call: call.id,
        chain: chainOf(meta),
        epoch: state.seedEpoch,
        profile,
        sessionId: meta.sessionId,
        stage: call.stage,
      }),
    });
  },
  noteContinuation = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<void> => {
    if (meta.continuation.kind === "continue" && meta.continuation.fallback) {
      await timeline(store, "ENGINE", `${call.role.toUpperCase()} could not continue its session, and started fresh: ${oneLine(meta.continuation.fallback, FALLBACK_MAX)}`);
    }
  };

export { noteContinuation, noteSeed, noteSession };
