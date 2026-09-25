/*
 * The parent steps its units, keeping at most limits.parallelUnits of them working at once. A unit
 * is queued (not started), working (a call runs), waiting (blocked on DENKEN or the user), ready
 * (unblocked, waiting for a free slot), done, or aborted.
 */
import { blockedSince, lastText, readUnit, statusOf, stepUnit, withUnit, working } from "./units-entries.ts";
import { pullVerdicts, unitsSummary } from "./parallel-read.ts";
import { NONE } from "./lists.ts";
import type { RunStore } from "./types-store.ts";
import type { StepOutcome } from "./types-units.ts";
import type { UnitEntry } from "./types-progress.ts";
import { assertLock } from "./lock.ts";
import { sleep } from "./processes.ts";
import { unitGate } from "./parallel-gate.ts";

// A unit's turn: its status before the step, and how many units were working.
interface Turn {
  readonly busy: number;
  readonly status: string;
  readonly unit: UnitEntry;
}

interface Stepping {
  readonly limit: number;
  readonly store: RunStore;
}

const POLL_MS = 2000,
  // A unit DENKEN has since unblocked is ready again, and needs a free slot like any other.
  refreshed = async (unit: UnitEntry): Promise<string> => {
    if (unit.status !== "waiting") {
      return unit.status;
    }
    if (lastText(unit, "action") === "error" || blockedSince(await readUnit(unit)) !== lastText(unit, "since")) {
      return "ready";
    }
    return unit.status;
  },
  takeStep = async (store: RunStore, turn: Turn): Promise<number> => {
    const last = await stepUnit(turn.unit),
      after = statusOf(last);
    store.apply({ units: withUnit(store.current().units, turn.unit.id, { last, started: true, status: after }) });
    return turn.busy + working(after) - working(turn.status);
  },
  // Steps one unit when it may take a slot; returns how many units are working after it.
  stepOne = async (stepping: Stepping, unit: UnitEntry, busy: number): Promise<number> => {
    const { store } = stepping,
      status = await refreshed(unit);
    if (status === "waiting" || (status !== "working" && busy >= stepping.limit)) {
      store.apply({ units: withUnit(store.current().units, unit.id, { status }) });
      return busy;
    }
    return takeStep(store, { busy, status, unit });
  },
  stepAll = async (stepping: Stepping, units: readonly UnitEntry[], busy: number): Promise<void> => {
    const [first, ...rest] = units;
    if (!first) {
      return;
    }
    if (first.status === "done" || first.status === "aborted") {
      await stepAll(stepping, rest, busy);
      return;
    }
    await stepAll(stepping, rest, await stepOne(stepping, first, busy));
  },
  stepRound = async (store: RunStore): Promise<void> => {
    const { assignment, units } = store.current(),
      busy = units.filter((unit) => unit.status === "working").length;
    await stepAll({ limit: assignment.limits.parallelUnits, store }, units, busy);
    await pullVerdicts(store);
  },
  running = (store: RunStore): StepOutcome => ({
    action: { action: "running", next: "Run next again with --wait.", units: unitsSummary(store.current().units) },
    kind: "action",
  }),
  pause = async (deadline: number): Promise<void> => {
    const left = Math.max(NONE, deadline - Date.now());
    await sleep(Math.min(POLL_MS, left));
  },
  // Rounds over the units until one needs DENKEN, they are merged, or the wait is over.
  stepUnits = async (store: RunStore, deadline: number): Promise<StepOutcome> => {
    await stepRound(store);
    const outcome = await unitGate(store);
    if (outcome.kind !== "wait") {
      return outcome;
    }
    if (Date.now() >= deadline) {
      return running(store);
    }
    await assertLock();
    await store.save();
    await pause(deadline);
    return stepUnits(store, deadline);
  };

export { stepUnits };
