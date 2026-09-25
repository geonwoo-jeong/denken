/*
 * A command that changes a run holds the run's lock while it works, and gives it back however it
 * ends: done, stopped with an error, or interrupted by a signal, which is raised again once the
 * lock is released so the process ends the way the signal meant. From the moment the signal
 * arrives, assertLock refuses, so work still in flight changes nothing more.
 */
import { acquireLock, releaseLock, stopHolding } from "./lock.ts";
import { openStore, runDirOf } from "./store.ts";
import type { RunStore } from "./types-store.ts";
import { fail } from "./output.ts";
import { once } from "node:events";

type Work = (store: RunStore) => Promise<void>;

// The work to do with the lock, and what to do when another process holds it.
interface Handlers {
  readonly busy: () => void;
  readonly work: Work;
}

const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"],
  // The work's end, or the signal that came first ("" when the work ended).
  untilSignal = async (work: () => Promise<void>): Promise<string> => {
    const controller = new AbortController(),
      finished = async (): Promise<string> => {
        await work();
        return "";
      },
      signalled = SIGNALS.map(async (signal): Promise<string> => {
        await once(process, signal, { signal: controller.signal });
        return signal;
      });
    try {
      const first = await Promise.race([finished(), ...signalled]);
      return first;
    } finally {
      controller.abort();
    }
  },
  // Every signal stops the lock's use at once; these listeners also keep the signal from ending the process before the lock is released.
  watchSignals = (): void => {
    for (const signal of SIGNALS) {
      process.on(signal, stopHolding);
    }
  },
  unwatchSignals = (): void => {
    for (const signal of SIGNALS) {
      process.off(signal, stopHolding);
    }
  },
  withLock = async (runDir: string, work: Work): Promise<void> => {
    watchSignals();
    try {
      const signal = await untilSignal(async () => {
        const store = await openStore(runDir);
        await work(store);
      });
      if (signal) {
        await releaseLock();
        unwatchSignals();
        process.kill(process.pid, signal);
      }
    } finally {
      unwatchSignals();
      await releaseLock();
    }
  },
  locked = async (runArg: string, waitMs: number, work: Work): Promise<void> => {
    const runDir = await runDirOf(runArg);
    if (!(await acquireLock(runDir, waitMs))) {
      fail("another DENKEN engine process is working on this run; wait for it, then try again");
    }
    await withLock(runDir, work);
  },
  // Like locked, for a caller that says what to do when another process holds the lock.
  lockedOr = async (runArg: string, waitMs: number, handlers: Handlers): Promise<void> => {
    const runDir = await runDirOf(runArg);
    if (await acquireLock(runDir, waitMs)) {
      await withLock(runDir, handlers.work);
      return;
    }
    handlers.busy();
  };

export { locked, lockedOr };
