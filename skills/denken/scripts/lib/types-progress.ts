// What a run keeps about its progress: confirmations, ticks, QA cycles, seeds, sessions and units.
import type { Level, Provider } from "./types-config.ts";
import type { TextMap, Tree } from "./types-names.ts";
import type { JsonObject } from "./types-json.ts";

interface Hashes {
  readonly request: string;
  readonly todoDev: string;
  readonly todoQa: string;
}

// The user's confirmation of the scope and TODO lists. An empty at means none yet.
interface Confirmation {
  readonly at: string;
  readonly hashes: Hashes;
  readonly units: boolean;
  readonly userSaid: string;
}

interface SecretHit {
  readonly file: string;
  readonly kind: string;
  readonly line: number;
}

interface Acceptance {
  readonly at: string;
  readonly findings: readonly SecretHit[];
  readonly userSaid: string;
}

interface TickBase {
  readonly at: string;
  readonly call: string;
  readonly tree: Tree;
}

interface Untick {
  readonly at: string;
  readonly cycle: number;
  readonly tree: Tree;
}

interface FixCycle {
  readonly at: string;
  readonly items: readonly string[];
  readonly qa: string;
  readonly tree: Tree;
}

interface SeedSession {
  readonly at: string;
  readonly call: string;
  readonly lastUsedAt: string;
  readonly perspective: string;
  readonly provider: Provider;
  readonly sessionId: string;
  readonly stage: string;
}

interface WorkSession {
  readonly at: string;
  readonly call: string;
  readonly chain: number;
  readonly epoch: number;
  readonly profile: string;
  readonly sessionId: string;
  readonly stage: string;
}

// An explicit model or effort DENKEN gave a role; empty means not given.
interface Override {
  readonly effort: string;
  readonly model: string;
}

// A unit as its parent run keeps it. last is the unit engine's last printed action.
interface UnitEntry {
  readonly id: string;
  readonly last: JsonObject;
  readonly levels: TextMap<Level>;
  readonly num: number;
  readonly pulled: number;
  readonly reqs: readonly string[];
  readonly root: string;
  readonly run: string;
  readonly scope: readonly string[];
  readonly started: boolean;
  readonly status: string;
  readonly title: string;
}

interface UnitsConfirmation {
  readonly at: string;
  readonly userSaid: string;
}

export type {
  Acceptance,
  Confirmation,
  FixCycle,
  Hashes,
  Override,
  SecretHit,
  SeedSession,
  TickBase,
  UnitEntry,
  UnitsConfirmation,
  Untick,
  WorkSession,
};
