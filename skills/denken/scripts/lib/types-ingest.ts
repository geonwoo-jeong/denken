// A checker's finished call, as ingest hands it over: the call, its meta, and its parsed output.
import type { Meta, QaOutput, ReviewOutput } from "./types-call.ts";
import type { ActiveCall } from "./types-items.ts";

interface ReviewResult {
  readonly call: ActiveCall;
  readonly meta: Meta;
  readonly outPath: string;
  readonly output: ReviewOutput;
}

interface QaResult {
  readonly call: ActiveCall;
  readonly meta: Meta;
  readonly outPath: string;
  readonly output: QaOutput;
}

export type { QaResult, ReviewResult };
