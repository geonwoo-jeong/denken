/*
 * A run's state as one engine process holds it: read with current(), changed with apply(), which
 * returns the new state, and written to state.json with save(). The state itself is never changed
 * in place; every change makes a new one.
 */
import type { RunState } from "./types-run.ts";

interface RunStore {
  readonly apply: (changes: Readonly<Partial<RunState>>) => RunState;
  readonly current: () => RunState;
  readonly dir: string;
  readonly save: () => Promise<void>;
}

export type { RunStore };
