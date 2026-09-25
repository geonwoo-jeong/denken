// The outcomes of stepping units that carry no action: blocked, merged, or nothing yet.
import type { StepOutcome } from "./types-units.ts";

const BLOCKED: StepOutcome = { action: {}, kind: "blocked" },
  MERGED: StepOutcome = { action: {}, kind: "merged" },
  WAIT: StepOutcome = { action: {}, kind: "wait" };

export { BLOCKED, MERGED, WAIT };
