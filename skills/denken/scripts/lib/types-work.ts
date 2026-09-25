// Shapes the engine's parts hand each other: changes, guard snapshots, ticks, agent CLI runs, levels.
import type { ContinuePlan, Guard, NoPlan, SeedPlan, TickEntry } from "./types-call.ts";
import type { Grants, Level, Provider } from "./types-config.ts";
import type { Override } from "./types-progress.ts";
import type { Tree } from "./types-names.ts";

// Files changed since a stage began: tracked changes plus new untracked files.
interface StageChanges {
  readonly changed: readonly string[];
  readonly untracked: readonly string[];
}

/*
 * The project and DENKEN's own files at one moment: hashes of what a call may or may not change,
 * and where each of DENKEN's paths and their folders is a symlink (to what; empty when it is not).
 */
interface Snapshot {
  readonly ignored: Tree;
  readonly links: Tree;
  readonly owned: Tree;
  readonly project: string;
}

// What a guard compares after a call, and DENKEN's files as pinned before it, to restore them from.
interface ViolationCheck {
  readonly after: Snapshot;
  readonly before: Snapshot;
  readonly callId: string;
  readonly guard: Guard;
  readonly pinned: Pins;
  readonly runDir: string;
}

/*
 * What a call left at a path it may not change, held in memory until every repair is done: where it
 * goes under the call's .tampered folder, and its content (latin1).
 */
interface Evidence {
  readonly content: string;
  readonly path: string;
}

// A file as the guard pinned it: its content (latin1) and permission bits, or why it could not be read.
interface Pin {
  readonly content: string;
  readonly mode: number;
  readonly unreadable: string;
}

type Pins = Readonly<Record<string, Pin>>;

// What a guard found: the lines to report, and the evidence to keep.
interface Found {
  readonly evidence: readonly Evidence[];
  readonly lines: readonly string[];
}

// An existing doc that mentions files this run changed.
interface RelatedDoc {
  readonly byPath: number;
  readonly doc: string;
  readonly mentions: readonly string[];
  readonly mustUpdate: boolean;
}

// Where an item's evidence is measured from, and how that moment is described.
interface ItemBase {
  readonly at: string;
  readonly tree: Tree;
  readonly what: string;
}

interface TickRejection {
  readonly item: string;
  readonly problem: string;
}

interface AppliedTicks {
  readonly applied: readonly TickEntry[];
  readonly rejected: readonly TickRejection[];
}

// One agent CLI run: its command line, input, files and time limit.
interface CliRun {
  readonly args: readonly string[];
  readonly base: string;
  readonly env: Readonly<Record<string, string>>;
  readonly input: string;
  readonly provider: Provider;
  readonly timeoutMs: number;
}

// How it ended: status is -1 without an exit code; error is the spawn error's message, if any.
interface CliResult {
  readonly error: string;
  readonly signal: string;
  readonly status: number;
  readonly timedOut: boolean;
}

// Levels and explicit models or efforts DENKEN chose, by role.
interface Choices {
  readonly levels: Readonly<Record<string, Level>>;
  readonly overrides: Readonly<Record<string, Override>>;
}

// A call's plans for how it starts: the seed it forks, or the session it continues.
interface StartPlans {
  readonly continuation: ContinuePlan | NoPlan;
  readonly seed: NoPlan | SeedPlan;
}

// Where the config files are.
interface ConfigPaths {
  readonly global: string;
  readonly local: string;
  readonly shared: string;
}

interface GrantSet {
  readonly granted: boolean;
  readonly grants: Grants;
}

export type { AppliedTicks, Choices, CliResult, CliRun, ConfigPaths, Evidence, Found, GrantSet, ItemBase, Pin, Pins, RelatedDoc, Snapshot, StageChanges, StartPlans, TickRejection, ViolationCheck };
