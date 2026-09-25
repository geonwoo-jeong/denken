// A ruling DENKEN asked for: its decision, its note, the stage it is on, and the findings it dismisses.
import type { Block } from "./types-block.ts";
import type { Stage } from "./types-names.ts";

interface RuleRequest {
  readonly blocked: Block;
  readonly decision: string;
  readonly note: string;
  readonly stage: Stage;
  readonly targets: readonly string[];
}

// A ruling as recorded: its id and its step file.
interface Ruled {
  readonly file: string;
  readonly id: string;
}

export type { RuleRequest, Ruled };
