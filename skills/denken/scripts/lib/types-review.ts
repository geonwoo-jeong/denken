// A review as the engine judges it.
import type { Finding } from "./types-items.ts";

/*
 * The engine's word on a review (APPROVED when no blocking finding is left open after DENKEN's
 * dismissals), the note when the reviewer's own verdict differs, the open findings, and whether it
 * reviewed the merged units.
 */
interface Judged {
  readonly merged: boolean;
  readonly note: string;
  readonly open: readonly Finding[];
  readonly word: string;
}

export type { Judged };
