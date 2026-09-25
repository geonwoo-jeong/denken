// Why a run waits, and on whom: the block, and the details DENKEN is shown with it.
import type { ActiveCall, Denial, PermissionRequest, StoredFinding } from "./types-items.ts";
import type { BlockKind } from "./types-names.ts";
import type { SecretHit } from "./types-progress.ts";

// A recovery item reported blocked, with the report line that says so.
interface StuckItem {
  readonly item: string;
  readonly report: string;
  readonly text: string;
}

interface PermissionLimit {
  readonly attemptsPerCall: number;
  readonly perRole: number;
}

// The details of a block; which ones are given depends on its reason.
interface BlockInfo {
  readonly asks?: number;
  readonly blockingPerRound?: readonly number[];
  readonly call?: string;
  readonly callInfo?: ActiveCall;
  readonly changed?: readonly string[];
  readonly checked?: string;
  readonly count?: number;
  readonly cycles?: readonly number[];
  readonly denials?: readonly Denial[];
  readonly effort?: string;
  readonly error?: string;
  readonly findings?: readonly SecretHit[];
  readonly identities?: readonly string[];
  readonly identity?: string;
  readonly items?: readonly StuckItem[];
  readonly limit?: number | PermissionLimit;
  readonly log?: string;
  readonly model?: string;
  readonly occurrences?: readonly StoredFinding[];
  readonly patch?: string;
  readonly provider?: string;
  readonly ranAs?: string;
  readonly recovery?: string;
  readonly requests?: readonly PermissionRequest[];
  readonly resolveWith?: string;
  readonly role?: string;
  readonly rounds?: number;
  readonly rule?: string;
  readonly stage?: string;
  readonly status?: readonly string[];
  readonly unit?: string;
  readonly userRequired?: boolean;
  readonly violations?: readonly string[];
}

interface Block {
  readonly info: BlockInfo;
  readonly kind: BlockKind;
  readonly reason: string;
  readonly since: string;
}

export type { Block, BlockInfo, PermissionLimit, StuckItem };
