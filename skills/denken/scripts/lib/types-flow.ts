// What the engine prints for DENKEN, and what waiting on a call came to.
import type { Meta } from "./types-call.ts";

type Action = Readonly<Record<string, unknown>>;

// A call still running when the wait ended, or its result (a failure when its process died without one).
interface CallWait {
  readonly meta: Meta;
  readonly running: boolean;
}

export type { Action, CallWait };
