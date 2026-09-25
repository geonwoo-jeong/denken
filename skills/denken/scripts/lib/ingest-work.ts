// A worker's result: its ticks applied, its step recorded, then the engine's own checks, which send the work straight back without spending a review on it.
import { NONE, hasItems, increment, patch, withEntry } from "./lists.ts";
import { fixBlocked, takeTicks } from "./ingest-fix.ts";
import type { ActiveCall } from "./types-items.ts";
import type { Meta } from "./types-call.ts";
import type { RunStore } from "./types-store.ts";
import { block } from "./blocks.ts";
import { logWork } from "./ingest-log-work.ts";
import { returnedByEngine } from "./ingest-engine.ts";

const STREAK_LIMIT = 2,
  streakAfter = (streak: number, meta: Meta): number => {
    if (hasItems(meta.denials)) {
      return increment(streak);
    }
    return NONE;
  },
  // Permissions that blocked the worker twice in a row need DENKEN.
  noteDenials = (store: RunStore, call: ActiveCall, meta: Meta): void => {
    const { denialStreak } = store.current(),
      streak = streakAfter(denialStreak[call.stage], meta);
    store.apply({ denialStreak: patch(denialStreak, { [call.stage]: streak }) });
    if (streak >= STREAK_LIMIT) {
      block(store, "permission", {
        info: { call: call.id, callInfo: call, denials: meta.denials, provider: call.provider, requests: [], resolveWith: "grant", role: call.role },
        reason: "repeated_permission_denials",
      });
    }
  },
  ingestWork = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<void> => {
    store.apply({
      lastWork: withEntry(store.current().lastWork, call.stage, { call: call.id, denials: meta.denials, effort: meta.facts.effort, modelRan: meta.facts.modelRan, provider: call.provider }),
      pending: "review",
    });
    const rejected = await takeTicks(store, call);
    await logWork(store, call, meta);
    if ((await returnedByEngine(store, call, rejected)) || (await fixBlocked(store, call))) {
      return;
    }
    noteDenials(store, call, meta);
  };

export { ingestWork };
