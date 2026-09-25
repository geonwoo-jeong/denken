/*
 * The engine's own checks, run before the reviewer: TODO lists with coverage gaps go straight back
 * to METHODE, DEV items STARK neither ticked off nor reported blocked go straight back to STARK, and
 * non-docs changed in the wiki stage go back to SERIE, as an engine round, without spending a review.
 */
import { CHECKED, stageGaps } from "./ingest-gaps.ts";
import type { ActiveCall } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import type { TickRejection } from "./types-work.ts";
import { hasItems } from "./lists.ts";
import { recordReview } from "./findings.ts";
import { returnGaps } from "./gaps-file.ts";

const returnedByEngine = async (store: RunStore, call: ActiveCall, rejected: readonly TickRejection[]): Promise<boolean> => {
  const gaps = await stageGaps(store, call, rejected);
  if (!hasItems(gaps)) {
    return false;
  }
  await returnGaps(store, call, { checked: CHECKED[call.stage] ?? "", gaps });
  recordReview(store, { call, findings: gaps, stage: call.stage });
  return true;
};

export { returnedByEngine };
