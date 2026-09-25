// The loop behind next: advancing the run, and telling DENKEN what it needs to do.
import { fail, print } from "./output.ts";
import type { RunStore } from "./types-store.ts";
import { actionFor } from "./flow-actions.ts";
import { assertLock } from "./lock.ts";
import { launch } from "./call-launch.ts";
import { scopeChanged } from "./flow-scope.ts";
import { stepCall } from "./flow-call.ts";
import { stepUnitsOnce } from "./flow-units-step.ts";

const MS_PER_SECOND = 1000,
  unitsWorking = (store: RunStore): boolean => {
    const { blocked, stage } = store.current();
    return stage === "units" && (blocked.kind === "none" || blocked.reason === "confirm_todos");
  },
  finishedOrWaiting = (store: RunStore): boolean => {
    const { blocked, stage } = store.current();
    return stage === "done" || stage === "aborted" || blocked.kind !== "none";
  },
  // Launches the next call; the run moves on unless the wait is over.
  launchNext = async (store: RunStore, deadline: number): Promise<boolean> => {
    await assertLock();
    await launch(store);
    if (Date.now() >= deadline) {
      print(await actionFor(store));
      return false;
    }
    return true;
  },
  // One step of the run; returns whether to take another.
  step = async (store: RunStore, deadline: number): Promise<boolean> => {
    if (store.current().stage === "intake") {
      fail("the run has not started; write request.md, confirm it with the user, then run start");
    }
    if (unitsWorking(store)) {
      return stepUnitsOnce(store, deadline);
    }
    if (finishedOrWaiting(store)) {
      print(await actionFor(store));
      return false;
    }
    // A call in flight is waited on; with none, a scope change since the user confirmed stops the run first.
    if (store.current().inflight.kind === "call" || (await scopeChanged(store))) {
      return stepCall(store, deadline);
    }
    return launchNext(store, deadline);
  },
  advance = async (store: RunStore, deadline: number): Promise<void> => {
    if (await step(store, deadline)) {
      await advance(store, deadline);
    }
  },
  // The next command's work: advance the run until it needs DENKEN, or the wait is over.
  advanceRun = async (store: RunStore, waitSec: number): Promise<void> => {
    await advance(store, Date.now() + waitSec * MS_PER_SECOND);
  };

export { advanceRun };
