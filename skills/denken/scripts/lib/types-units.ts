// A split of the request into units, as units.md describes it.
import type { JsonObject } from "./types-json.ts";
import type { Level } from "./types-config.ts";

// A unit's line in units.md: "- UNIT-1 (REQ-001) <title>. Scope: `src/a/`. Levels: dev=heavy".
interface UnitLine {
  readonly id: string;
  readonly levelPairs: readonly (readonly [string, string])[];
  readonly num: number;
  readonly reqs: readonly string[];
  readonly scope: readonly string[];
  readonly title: string;
}

// A unit with the levels its line gives its roles, over the run's.
interface UnitPlan extends UnitLine {
  readonly levels: Readonly<Record<string, Level>>;
}

interface UnitsCheck {
  readonly problems: readonly string[];
  readonly units: readonly UnitPlan[];
}

// What stepping the units came to: an action for DENKEN, a block, a merge, or nothing yet.
interface StepOutcome {
  readonly action: JsonObject;
  readonly kind: "action" | "blocked" | "merged" | "wait";
}

// A unit's changes as merged: the files, and whether its agent committed them.
interface MergedUnit {
  readonly committed: boolean;
  readonly files: readonly string[];
  readonly unit: string;
}

// A patch that did not apply: whose it was ("all" for the combined one), where it is, and git's error.
interface Conflict {
  readonly error: string;
  readonly patch: string;
  readonly unit: string;
}

// The units applied so far in the integration worktree, and the conflict that stopped it (unit "" = none).
interface MergeProgress {
  readonly conflict: Conflict;
  readonly merged: readonly MergedUnit[];
}

export type { Conflict, MergedUnit, MergeProgress, StepOutcome, UnitLine, UnitPlan, UnitsCheck };
