/*
 * A worker that asked for a permission stops here, whatever it produced: only DENKEN may widen what
 * a role can do, and the call runs again once DENKEN has decided. Requests are capped, and a need
 * DENKEN already denied for this role is denied again without stopping the run, so a worker cannot
 * stall it by asking over and over.
 */
import type { ActiveCall, PermissionRequest } from "./types-items.ts";
import { NONE, appended, eachInOrder, increment, isEmpty, withEntry } from "./lists.ts";
import { PERMISSION_ASKS_PER_ROLE, PERMISSION_ATTEMPTS_PER_CALL } from "./stage-table.ts";
import { callRequests, deniedNeeds } from "./permission-requests.ts";
import type { Meta } from "./types-call.ts";
import type { RunStore } from "./types-store.ts";
import { appendDecision } from "./record-rulings.ts";
import { block } from "./blocks.ts";
import { now } from "./text.ts";
import { timeline } from "./record-log.ts";

// The call that asked, and what it asked for.
interface Asked {
  readonly call: ActiveCall;
  readonly requests: readonly PermissionRequest[];
}

const needsOf = (requests: readonly PermissionRequest[]): string => requests.map((request) => request.need).join(", "),
  denyAgain = async (store: RunStore, asked: Asked): Promise<void> => {
    const { call, requests } = asked,
      state = store.current(),
      id = `P${increment(state.permissionDecisions.length)}`,
      who = call.role.toUpperCase(),
      note = `Asked again for ${needsOf(requests)}, which DENKEN already denied for this role. It stays denied: do the work without it, or report the item blocked.`;
    store.apply({ permissionDecisions: appended(state.permissionDecisions, { at: now(), by: "engine", call: call.id, decision: "deny", id, note, requests, role: call.role, userSaid: "", what: needsOf(requests) }) });
    await appendDecision(store.dir, `## ${id} · permission · ${who} · denied again (engine)\n\n${note}\n\n`);
    await timeline(store, "ENGINE", `${id}: ${who} asked again for ${needsOf(requests)}, already denied → denied again, ${call.id} runs again`);
    store.apply({ retryCall: { attempt: increment(call.attempt), kind: "retry", mode: call.mode, role: call.role, round: call.round, stage: call.stage } });
    if (call.mode === "work") {
      store.apply({ pending: "work" });
    }
  },
  loopBlock = (store: RunStore, asked: Asked, meta: Meta): void => {
    const { call, requests } = asked;
    block(store, "permission", {
      info: {
        asks: store.current().permissionAsks[call.role] ?? NONE,
        call: call.id,
        callInfo: call,
        denials: meta.denials,
        limit: { attemptsPerCall: PERMISSION_ATTEMPTS_PER_CALL, perRole: PERMISSION_ASKS_PER_ROLE },
        provider: call.provider,
        requests,
        resolveWith: "grant",
        role: call.role,
        userRequired: true,
      },
      reason: "permission_loop",
    });
  },
  decide = async (store: RunStore, asked: Asked, meta: Meta): Promise<void> => {
    const { call, requests } = asked,
      state = store.current(),
      asks = increment(state.permissionAsks[call.role] ?? NONE),
      denied = deniedNeeds(state.permissionDecisions, call.role);
    store.apply({ permissionAsks: withEntry(state.permissionAsks, call.role, asks) });
    if (asks > PERMISSION_ASKS_PER_ROLE || call.attempt >= PERMISSION_ATTEMPTS_PER_CALL) {
      loopBlock(store, asked, meta);
    } else if (requests.every((request) => denied.includes(request.need))) {
      await denyAgain(store, asked);
    } else {
      block(store, "permission", { info: { call: call.id, callInfo: call, denials: meta.denials, provider: call.provider, requests, resolveWith: "grant", role: call.role }, reason: "needs_permission" });
    }
  },
  askedForPermission = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<boolean> => {
    const requests = await callRequests(store.dir, call.id, call.attempt);
    await eachInOrder(requests, async (request) => {
      await timeline(store, call.role.toUpperCase(), `asked for permission: ${request.need} (${request.why})`);
    });
    if (isEmpty(requests)) {
      return false;
    }
    await decide(store, { call, requests }, meta);
    return true;
  };

export { askedForPermission };
