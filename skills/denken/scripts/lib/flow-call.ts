// The call in flight: wait for its result, and ingest it; a call whose process died is counted failed.
import type { ActiveCall } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { actionFor } from "./flow-actions.ts";
import { assertLock } from "./lock.ts";
import { callBase } from "./paths.ts";
import { ingest } from "./ingest.ts";
import { logStop } from "./record-stop.ts";
import { print } from "./output.ts";
import { waitForCall } from "./flow-wait.ts";

const awaitCall = async (store: RunStore, call: ActiveCall, deadline: number): Promise<boolean> => {
    const waited = await waitForCall(callBase(store.dir, call.id), call, deadline);
    if (waited.running) {
      print(await actionFor(store));
      return false;
    }
    await assertLock();
    await ingest(store, waited.meta);
    await logStop(store);
    await store.save();
    return true;
  },
  // Returns whether the run moves on: false when the call is still running at the deadline.
  stepCall = async (store: RunStore, deadline: number): Promise<boolean> => {
    const { inflight } = store.current();
    if (inflight.kind === "call") {
      const moved = await awaitCall(store, inflight, deadline);
      return moved;
    }
    return true;
  };

export { stepCall };
