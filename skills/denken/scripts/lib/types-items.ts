// The records a run keeps as it goes: findings, rulings, permissions, calls and blocks.
import type { Mode, Role, Stage } from "./types-names.ts";
import type { JsonValue } from "./types-json.ts";
import type { Provider } from "./types-config.ts";

// A finding: a reviewer's, or one of the engine's own checks. Empty text and 0 mean "not given".
interface Finding {
  readonly file: string;
  readonly identity: string;
  readonly line_end: number;
  readonly line_start: number;
  readonly problem: string;
  readonly request_item: string;
  readonly required_change: string;
  readonly severity: string;
  readonly source: string;
  readonly todo: string;
  readonly topic: string;
}

// A finding as a stage keeps it, with the round and call that raised it.
interface StoredFinding extends Finding {
  readonly call: string;
  readonly round: number;
  readonly stage: string;
}

interface History {
  readonly blocking: number;
  readonly round: number;
}

interface Ruling {
  readonly at: string;
  readonly decision: string;
  readonly id: string;
  readonly reason: string;
  readonly stage: string;
  readonly subject: string;
}

interface PermissionRequest {
  readonly at: string;
  readonly attempt: number;
  readonly need: string;
  readonly why: string;
}

interface PermissionDecision {
  readonly at: string;
  readonly by: string;
  readonly call: string;
  readonly decision: string;
  readonly id: string;
  readonly note: string;
  readonly requests: readonly PermissionRequest[];
  readonly role: string;
  readonly userSaid: string;
  readonly what: string;
}

// An action a role's permissions blocked, as its CLI reported it.
interface Denial {
  readonly input: JsonValue;
  readonly tool: string;
}

interface LastWork {
  readonly call: string;
  readonly denials: readonly Denial[];
  readonly effort: string;
  readonly modelRan: string;
  readonly provider: Provider;
}

// Which call comes next, before it has an id.
interface CallSpec {
  readonly attempt: number;
  readonly mode: Mode;
  readonly role: Role;
  readonly round: number;
  readonly stage: Stage;
}

interface Call extends CallSpec {
  readonly id: string;
  readonly nonce: string;
}

interface ActiveCall extends Call {
  readonly kind: "call";
  readonly provider: Provider;
  readonly started: string;
}

interface NoCall {
  readonly kind: "none";
}

interface RetryCall extends CallSpec {
  readonly kind: "retry";
}

type CallSlot = ActiveCall | NoCall;

type RetrySlot = NoCall | RetryCall;

interface CallRecord {
  readonly attempt: number;
  readonly denials: number;
  readonly exitCode: number;
  readonly finished: string;
  readonly id: string;
  readonly mode: Mode;
  readonly model: string;
  readonly provider: Provider;
  readonly sessionId: string;
  readonly started: string;
  readonly status: string;
}

export type {
  ActiveCall,
  Call,
  CallRecord,
  CallSlot,
  CallSpec,
  Denial,
  Finding,
  History,
  LastWork,
  NoCall,
  PermissionDecision,
  PermissionRequest,
  RetryCall,
  RetrySlot,
  Ruling,
  StoredFinding,
};
