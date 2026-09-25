// GENAU's report as the engine reads it: every QA item's result, and the request items each one checks.
import type { QaItem } from "./types-call.ts";

/*
 * Every QA item's result (one missing from the report failed), the failing ones DENKEN has not
 * dismissed, the request items an item checks, and its identity for counting repeats.
 */
interface QaView {
  readonly failing: readonly QaItem[];
  readonly identityOf: (item: QaItem) => string;
  readonly items: readonly QaItem[];
  readonly reqsOf: (item: QaItem) => readonly string[];
}

// A QA cycle's recovery items: their keys and lines.
interface Recovery {
  readonly cycle: number;
  readonly keys: readonly string[];
  readonly lines: readonly string[];
}

export type { QaView, Recovery };
