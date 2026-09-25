// Shapes the _exec runner hands between its phases: the command-line context, runs and their reports.
import type { CliResult, Snapshot } from "./types-work.ts";
import type { ContinueMeta, Facts, Job, Meta, NoPlan, SeedMeta, Tokens } from "./types-call.ts";
import type { Grants, Provider } from "./types-config.ts";
import type { Mode, Tree } from "./types-names.ts";
import type { Denial } from "./types-items.ts";

/*
 * What a call's command line depends on: its mode and agent, its files, what it may do, and
 * whether it forks FLAMME's seed (seeded). An empty system or protect means none.
 */
interface CliContext {
  readonly base: string;
  readonly effort: string;
  readonly grants: Grants;
  readonly mode: Mode;
  readonly model: string;
  readonly network: boolean;
  readonly outPath: string;
  readonly protect: string;
  readonly provider: Provider;
  readonly schemaPath: string;
  readonly schemaText: string;
  readonly seeded: boolean;
  readonly structured: boolean;
  readonly system: string;
}

/*
 * Where a run starts: a new session (sessionId), a fork or continuation of one (forkOf, resume), or
 * FLAMME's seed (forSeed). An empty out means the call's own output file.
 */
interface CliHow {
  readonly forkOf: string;
  readonly forSeed: boolean;
  readonly out: string;
  readonly resume: boolean;
  readonly sessionId: string;
}

// The facts a CLI's stream reports about a run: the model that ran, its cost, tokens and turns.
interface RunFacts {
  readonly costUsd: number;
  readonly modelRan: string;
  readonly tokens: Tokens;
  readonly turns: number;
}

// What a CLI run reported: its session, denials, errors and facts.
interface RunReport {
  readonly denials: readonly Denial[];
  readonly error: string;
  readonly errorText: string;
  readonly facts: RunFacts;
  readonly sessionId: string;
}

// A run of the call's CLI and what it reported.
interface Ran {
  readonly kind: "ran";
  readonly report: RunReport;
  readonly result: CliResult;
}

// The call as its job describes it: its files, its prompts, and the facts known before it runs.
interface CallContext {
  readonly base: string;
  readonly cacheEnv: Readonly<Record<string, string>>;
  readonly cli: CliContext;
  readonly facts: Facts;
  readonly job: Job;
  readonly message: string;
  readonly prompt: string;
  readonly runDir: string;
  readonly startedAt: number;
}

// The guard taken before anything runs: git's own files, and the snapshot and pinned files of the rest.
interface Guards {
  readonly before: Snapshot;
  readonly gitPinned: readonly PinnedFile[];
  readonly pinned: Tree;
}

/*
 * A git file as it was: its content (latin1) when present; where it pointed, and the real path it
 * resolved to, when a symlink; and, for a file in a folder of the git dir (info/exclude), where
 * that folder pointed.
 */
interface PinnedFile {
  readonly content: string;
  readonly folder: string;
  readonly link: string;
  readonly nested: boolean;
  readonly path: string;
  readonly present: boolean;
  readonly real: string;
}

// How a call ran: the session it continued, the seed it forked, and the run itself.
interface Attempt {
  readonly continuation: ContinueMeta | NoPlan;
  readonly ran: Ran;
  readonly seed: NoPlan | SeedMeta;
  readonly sessionId: string;
}

// The session a call forks (empty: none) and the record of FLAMME's seed.
interface SeedStep {
  readonly forkOf: string;
  readonly seed: NoPlan | SeedMeta;
}

// A worker's attempt to continue its session: what was recorded, and the run when it went ahead.
interface ContinueStep {
  readonly continuation: ContinueMeta | NoPlan;
  readonly ran: NoPlan | Ran;
  readonly sessionId: string;
}

// The call's own run, as a fork of its seed or fresh, and the seed's record after it.
interface StartStep {
  readonly ran: Ran;
  readonly seed: NoPlan | SeedMeta;
  readonly sessionId: string;
}

// One run of the CLI for a call: its files' base, extra environment, start, prompt and output file.
interface RunSpec {
  readonly base: string;
  readonly env: Readonly<Record<string, string>>;
  readonly how: CliHow;
  readonly input: string;
  readonly out: string;
}

// Where a run's streamed log is, where its final message goes, and how to read it.
interface RunTarget {
  readonly logPath: string;
  readonly outPath: string;
  readonly provider: Provider;
  readonly structured: boolean;
}

// What the run reported, as the call's result takes it.
interface Taken {
  readonly denials: readonly Denial[];
  readonly error: string;
  readonly errorText: string;
  readonly exitCode: number;
  readonly facts: Facts;
  readonly sessionId: string;
}

// What the verdict on a call is drawn from.
interface Judged {
  readonly result: CliResult;
  readonly taken: Taken;
  readonly violations: readonly string[];
}

// The call's status, and the error that goes with it.
interface Outcome {
  readonly error: string;
  readonly status: string;
}

// A call's result file: found once the call has written it.
interface MetaRead {
  readonly found: boolean;
  readonly meta: Meta;
}

export type { Attempt, CallContext, CliContext, CliHow, ContinueStep, Guards, Judged, MetaRead, Outcome, PinnedFile, Ran, RunFacts, RunReport, RunSpec, RunTarget, SeedStep, StartStep, Taken };
