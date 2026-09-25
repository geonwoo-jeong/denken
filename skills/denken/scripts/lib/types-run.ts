/*
 * A run's state.json: every field the engine keeps between its commands. Absence is written as a
 * zero value (an empty string, 0, an empty list or record) or, for the few slots that are either
 * filled or empty, as a tagged value whose kind is "none".
 */
import type { Acceptance, Confirmation, FixCycle, Override, SecretHit, SeedSession, TickBase, UnitEntry, UnitsConfirmation, Untick, WorkSession } from "./types-progress.ts";
import type { Assignment, Grants, Level, Provider } from "./types-config.ts";
import type { CallRecord, CallSlot, History, LastWork, PermissionDecision, RetrySlot, Ruling, StoredFinding } from "./types-items.ts";
import type { DevInput, RunStage, StageMap, TextMap } from "./types-names.ts";
import type { Block } from "./types-block.ts";

interface RunState {
  readonly approved: StageMap<string>;
  readonly assignment: Assignment;
  readonly baseRef: string;
  readonly blocked: Block;
  readonly calls: readonly CallRecord[];
  readonly capBase: StageMap<number>;
  readonly confirmations: readonly Confirmation[];
  readonly confirmed: Confirmation;
  readonly counts: StageMap<TextMap<number>>;
  readonly created: string;
  readonly currentFixCycle: number;
  readonly deferred: readonly StoredFinding[];
  readonly denialStreak: StageMap<number>;
  readonly devInput: DevInput;
  readonly dismissed: StageMap<readonly string[]>;
  readonly findings: StageMap<readonly StoredFinding[]>;
  readonly fixCount: number;
  readonly fixCycles: TextMap<FixCycle>;
  readonly grants: TextMap<Grants>;
  readonly history: StageMap<readonly History[]>;
  readonly historyBase: StageMap<number>;
  readonly idBase: number;
  readonly inflight: CallSlot;
  readonly lastQa: string;
  readonly lastQaFailing: readonly string[];
  readonly lastReview: StageMap<string>;
  readonly lastWork: TextMap<LastWork>;
  readonly levels: TextMap<Level>;
  readonly log: string;
  readonly loggedBlock: string;
  readonly mainPrint: string;
  readonly mainRoot: string;
  readonly overrides: TextMap<Override>;
  readonly pending: string;
  readonly permissionAsks: TextMap<number>;
  readonly permissionDecisions: readonly PermissionDecision[];
  readonly rawSeq: number;
  readonly requestIds: TextMap<string>;
  readonly retryCall: RetrySlot;
  readonly round: StageMap<number>;
  readonly ruled: StageMap<readonly string[]>;
  readonly rulings: readonly Ruling[];
  readonly runChanges: readonly string[];
  readonly runDeleted: readonly string[];
  readonly scope: readonly string[];
  readonly secretFindings: readonly SecretHit[];
  readonly secretsAccepted: Acceptance;
  readonly seedEpoch: number;
  readonly seeding: readonly Provider[];
  readonly seedSessions: TextMap<SeedSession>;
  readonly stage: RunStage;
  readonly stageBase: StageMap<string>;
  readonly stageEnteredAt: StageMap<string>;
  readonly task: string;
  readonly tickBases: TextMap<TickBase>;
  readonly title: string;
  readonly unit: string;
  readonly unitBase: string;
  readonly unitHome: string;
  readonly units: readonly UnitEntry[];
  readonly unitsConfirmed: UnitsConfirmation;
  readonly unitsMerged: string;
  readonly unticked: TextMap<Untick>;
  readonly untrackedAtStage: StageMap<readonly string[]>;
  readonly verdicts: readonly string[];
  readonly verdictsSha: string;
  readonly version: number;
  readonly workSessions: TextMap<WorkSession>;
}

export type {
  RunState,
};
