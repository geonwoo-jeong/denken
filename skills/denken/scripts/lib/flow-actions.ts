// The action `next` prints for DENKEN: done, aborted, waiting on a ruling or the user, or a call still running.
import { abortedAction, doneAction } from "./flow-ends.ts";
import { confirmAction, permissionAction, rulingAction } from "./flow-blocked.ts";
import type { Action } from "./types-flow.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { secondsSince } from "./exec-values.ts";
import { unitsAction } from "./flow-units.ts";
import { userAction } from "./flow-user.ts";

// The user is waiting to confirm the scope, or on something else only the user can resolve.
const waitingAction = async (store: RunStore): Promise<Action> => {
    const state = store.current();
    if (state.blocked.reason === "confirm_todos" || state.blocked.reason === "scope_changed") {
      const action = await confirmAction(store);
      return action;
    }
    return userAction(state);
  },
  blockedAction = async (store: RunStore): Promise<Action> => {
    if (store.current().stage === "units") {
      return unitsAction(store.dir, store.current());
    }
    if (store.current().blocked.kind === "ruling") {
      return rulingAction(store);
    }
    if (store.current().blocked.kind === "permission") {
      return permissionAction(store.current());
    }
    const action = await waitingAction(store);
    return action;
  },
  runningAction = (state: RunState): Action => {
    const call = state.inflight;
    if (call.kind === "none") {
      return { action: "running", next: "Run next again with --wait." };
    }
    return { action: "running", call: call.id, elapsedSec: secondsSince(Date.parse(call.started)), next: "Run next again with --wait.", provider: call.provider, round: call.round, stage: call.stage };
  },
  actionFor = async (store: RunStore): Promise<Action> => {
    const state = store.current();
    if (state.stage === "done") {
      return doneAction(store.dir, state);
    }
    if (state.stage === "aborted") {
      const action = await abortedAction(store.dir, state);
      return action;
    }
    if (state.blocked.kind !== "none") {
      const action = await blockedAction(store);
      return action;
    }
    return runningAction(state);
  };

export { actionFor };
