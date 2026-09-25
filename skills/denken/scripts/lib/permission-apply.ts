// A permission decision in the run's state: the role's grants widened (for a grant), the decision kept, and the call run again.
import { NONE, appended, increment, patch, unique, withEntry } from "./lists.ts";
import type { Decision } from "./types-permission.ts";
import type { Grants } from "./types-config.ts";
import { NO_BLOCK } from "./state-zero.ts";
import type { PermissionRequest } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { now } from "./text.ts";

const NO_GRANTS: Grants = { dirs: [], domains: [], network: false, tools: [] },
  merged = (current: Grants, decision: Decision): Grants => {
    if (decision.decision !== "grant") {
      return current;
    }
    const { grant } = decision;
    return {
      dirs: unique([...current.dirs, ...grant.dirs]),
      domains: unique([...current.domains, ...grant.domains]),
      network: current.network || grant.network,
      tools: unique([...current.tools, ...grant.tools]),
    };
  },
  networkPart = (grant: Grants): readonly string[] => {
    if (grant.network) {
      return ["network (all hosts)"];
    }
    return [];
  },
  whatOf = (decision: string, grant: Grants, requests: readonly PermissionRequest[]): string => {
    if (decision !== "grant") {
      return requests.map((request) => request.need).join(", ") || "the blocked actions";
    }
    return [...networkPart(grant), ...grant.domains.map((domain) => `domain ${domain}`), ...grant.dirs.map((dir) => `dir ${dir}`), ...grant.tools.map((tool) => `tool ${tool}`)].join(", ");
  },
  keepDecision = (store: RunStore, decision: Decision): void => {
    const state = store.current(),
      { role } = decision.call;
    store.apply({
      grants: withEntry(state.grants, role, merged(state.grants[role] ?? NO_GRANTS, decision)),
      permissionDecisions: appended(state.permissionDecisions, {
        at: now(),
        by: "denken",
        call: decision.call.id,
        decision: decision.decision,
        id: decision.id,
        note: decision.note,
        requests: state.blocked.info.requests ?? [],
        role,
        userSaid: decision.userSaid,
        what: decision.what,
      }),
    });
  },
  // Either way the same call runs again, with the next attempt number.
  runAgain = (store: RunStore, decision: Decision): void => {
    const { call } = decision,
      state = store.current();
    store.apply({
      blocked: NO_BLOCK,
      denialStreak: patch(state.denialStreak, { [call.stage]: NONE }),
      retryCall: { attempt: increment(call.attempt), kind: "retry", mode: call.mode, role: call.role, round: call.round, stage: call.stage },
    });
    if (call.mode === "work") {
      store.apply({ pending: "work" });
    }
  };

export { keepDecision, runAgain, whatOf };
