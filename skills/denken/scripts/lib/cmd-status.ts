// The status command: a compact summary of the run, its call in flight, its tokens, and its units.
import { ROOT, callBase } from "./paths.ts";
import { agentLabel, roleAgents } from "./levels.ts";
import { entriesOf, hasItems, mapAsync } from "./lists.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { lastActivity } from "./status-activity.ts";
import path from "node:path";
import { print } from "./output.ts";
import { tokenReport } from "./status-tokens.ts";
import { unitsStatus } from "./status-units.ts";

const RECENT_CALLS = -6,
  rolesOf = (state: RunState): Readonly<Record<string, string>> => {
    if (state.stage === "intake") {
      return {};
    }
    return Object.fromEntries(entriesOf(roleAgents(state)).map(([role, agent]) => [role, agentLabel(agent)]));
  },
  summaryOf = (store: RunStore): Readonly<Record<string, unknown>> => {
    const state = store.current();
    return {
      approved: state.approved,
      calls: state.calls.slice(RECENT_CALLS).map((call) => `${call.id} ${call.provider} ${call.status || "running"}`),
      deferred: state.deferred.length,
      pending: state.pending,
      roles: rolesOf(state),
      rounds: state.round,
      rulings: state.rulings.map((ruling) => `${ruling.id} ${ruling.stage} ${ruling.subject} ${ruling.decision}`),
      run: path.relative(ROOT, store.dir),
      stage: state.stage,
      task: state.task,
      topics: state.counts,
    };
  },
  extrasOf = async (store: RunStore): Promise<Readonly<Record<string, unknown>>> => {
    const { blocked, inflight, units } = store.current(),
      extras: Record<string, unknown> = { tokens: await tokenReport(store) };
    if (inflight.kind === "call") {
      extras["inflight"] = { activity: await lastActivity(`${callBase(store.dir, inflight.id)}.log`), call: inflight.id, provider: inflight.provider, started: inflight.started };
    }
    if (blocked.kind !== "none") {
      extras["blocked"] = { kind: blocked.kind, reason: blocked.reason };
    }
    if (hasItems(units)) {
      extras["units"] = await mapAsync(units, unitsStatus);
    }
    return extras;
  },
  cmdStatus = async (store: RunStore): Promise<void> => {
    const extras = await extrasOf(store);
    print(Object.assign(summaryOf(store), extras));
  };

export { cmdStatus };
