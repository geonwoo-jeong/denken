/*
 * After the merge: development is measured from the project as it was before it, the merged TODO
 * lists replace the parent's, the units' own records are kept beside the parent's, and the units'
 * worktrees are removed. UBEL then reviews the merged change, and GENAU verifies it again.
 */
import { STEP, isEmpty, patch } from "./lists.ts";
import { listNames, removePath } from "./files.ts";
import type { MergedUnit } from "./types-units.ts";
import type { RunStore } from "./types-store.ts";
import { composeMerged } from "./merge-compose.ts";
import { confirmedHashes } from "./todo.ts";
import { now } from "./text.ts";
import path from "node:path";
import { recordMerge } from "./merge-record.ts";
import { tearDownUnits } from "./units-worktree.ts";

// The project before the merge: its base, and the untracked files it already had.
interface Before {
  readonly base: string;
  readonly untracked: readonly string[];
}

const removeUnitHome = async (store: RunStore): Promise<void> => {
    const home = store.current().unitHome;
    await tearDownUnits(store.current());
    await removePath(home);
    if (isEmpty(await listNames(path.dirname(home)))) {
      await removePath(path.dirname(home));
    }
  },
  // The dev stage after the merge, built from the state as it is now.
  enterMergedDev = (store: RunStore): void => {
    const state = store.current();
    store.apply({ approved: patch(state.approved, { plan: "units" }), devInput: "merge", pending: "review", round: patch(state.round, { dev: STEP }), stage: "dev", unitsMerged: now() });
  },
  finishMerge = async (store: RunStore, merged: readonly MergedUnit[], before: Before): Promise<void> => {
    const state = store.current();
    store.apply({
      stageBase: patch(state.stageBase, { dev: before.base }),
      stageEnteredAt: patch(state.stageEnteredAt, { dev: now() }),
      untrackedAtStage: patch(state.untrackedAtStage, { dev: before.untracked }),
    });
    await composeMerged(store);
    store.apply({ confirmed: { at: now(), hashes: await confirmedHashes(store.dir), units: true, userSaid: store.current().unitsConfirmed.userSaid } });
    await recordMerge(store, merged);
    await removeUnitHome(store);
    enterMergedDev(store);
  };

export { finishMerge };
