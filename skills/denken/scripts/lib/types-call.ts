// A call as the _exec process runs it (its job), and what it hands back (its meta and output).
import type { Agent, Grants } from "./types-config.ts";
import type { Call, Denial, Finding } from "./types-items.ts";

// What a call may change: the project (frozen or not), ignored files, and run files it writes.
interface Guard {
  readonly allow: readonly string[];
  readonly frozen: boolean;
  readonly ignored: "all" | "env" | "none";
}

// The agent a job runs as, with the grants DENKEN gave its role (granted: the role has an entry).
interface JobAgent extends Agent {
  readonly granted: boolean;
  readonly grants: Grants;
}

interface NoPlan {
  readonly kind: "none";
}

// FLAMME's seed the call forks. An empty sessionId means the seed is made by this call.
interface SeedPlan {
  readonly key: string;
  readonly kind: "seed";
  readonly perspective: string;
  readonly rewarm: boolean;
  readonly sessionId: string;
}

// The worker's own earlier session this call continues.
interface ContinuePlan {
  readonly chain: number;
  readonly from: string;
  readonly kind: "continue";
  readonly sessionId: string;
  readonly since: string;
}

interface Job extends Call {
  readonly agent: JobAgent;
  readonly continuation: ContinuePlan | NoPlan;
  readonly guard: Guard;
  readonly log: string;
  readonly protect: string;
  readonly seed: NoPlan | SeedPlan;
  readonly stageBase: string;
  readonly timeoutMs: number;
}

// Token counts; -1 means the CLI did not report it.
interface Tokens {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly input: number;
  readonly output: number;
}

// The facts of a call for the record. Empty text and -1 mean unknown.
interface Facts {
  readonly cliVersion: string;
  readonly continued: string;
  readonly costUsd: number;
  readonly durationSec: number;
  readonly effort: string;
  readonly exitCode: number;
  readonly grants: string;
  readonly head: string;
  readonly level: string;
  readonly model: string;
  readonly modelRan: string;
  readonly provider: string;
  readonly seed: string;
  readonly sessionId: string;
  readonly stageBase: string;
  readonly tokens: Tokens;
  readonly turns: number;
}

interface SeedMeta {
  readonly created: boolean;
  readonly facts: Facts;
  readonly fallback: string;
  readonly key: string;
  readonly kind: "seed";
  readonly rewarmed: boolean;
  readonly sessionId: string;
}

interface ContinueMeta {
  readonly chain: number;
  readonly fallback: string;
  readonly from: string;
  readonly kind: "continue";
  readonly sessionId: string;
}

// The result file of a call: its appearance tells `next` the call is over. exitCode -1: none.
interface Meta {
  readonly continuation: ContinueMeta | NoPlan;
  readonly denials: readonly Denial[];
  readonly error: string;
  readonly exitCode: number;
  readonly facts: Facts;
  readonly finished: string;
  readonly nonce: string;
  readonly seed: NoPlan | SeedMeta;
  readonly sessionId: string;
  readonly status: string;
  readonly violations: readonly string[];
}

interface ReviewOutput {
  readonly checked: readonly string[];
  readonly findings: readonly Finding[];
  readonly summary: string;
  readonly verdict: string;
}

interface QaItem {
  readonly check: string;
  readonly evidence: string;
  readonly evidence_files: readonly string[];
  readonly how_verified: string;
  readonly id: string;
  readonly reproduce: string;
  readonly request_item: string;
  readonly result: string;
}

interface QaOutput {
  readonly items: readonly QaItem[];
  readonly result: string;
  readonly summary: string;
}

// One line of STARK's tick ledger, written by the tick command.
interface TickEntry {
  readonly at: string;
  readonly cited: readonly string[];
  readonly command: string;
  readonly evidence: string;
  readonly exitCode: number;
  readonly item: string;
  readonly lastLine: string;
  readonly log: string;
  readonly logSha: string;
  readonly noChange: boolean;
  readonly since: string;
}

export type {
  ContinueMeta,
  ContinuePlan,
  Facts,
  Guard,
  Job,
  JobAgent,
  Meta,
  NoPlan,
  QaItem,
  QaOutput,
  ReviewOutput,
  SeedMeta,
  SeedPlan,
  TickEntry,
  Tokens,
};
