/*
 * Every unit is done: merge them all, or none. The units' patches are applied together in an
 * integration worktree first; only the combined patch that results is applied to the project.
 */
import type { MergedUnit, StepOutcome } from "./types-units.ts";
import { addWorktree, removeWorktree } from "./units-worktree.ts";
import { applyMerged, conflictOutcome } from "./merge-apply.ts";
import { applyUnits, combine } from "./merge-patches.ts";
import { BLOCKED } from "./step-outcomes.ts";
import type { RunStore } from "./types-store.ts";
import { mainChanged } from "./units-home.ts";
import { makeDir } from "./files.ts";
import path from "node:path";

// Where the merge works: the integration worktree, and the folder the patches are kept in.
interface MergePlace {
  readonly dir: string;
  readonly integration: string;
}

const mergeCombined = async (store: RunStore, place: MergePlace, merged: readonly MergedUnit[]): Promise<StepOutcome> => {
    const patch = await combine(store, place);
    if (await mainChanged(store)) {
      return BLOCKED;
    }
    return applyMerged(store, { file: path.join(place.dir, "merged.patch"), merged, patch });
  },
  mergeInto = async (store: RunStore, place: MergePlace): Promise<StepOutcome> => {
    const progress = await applyUnits(store, place);
    if (progress.conflict.unit) {
      return conflictOutcome(store, progress.conflict);
    }
    return mergeCombined(store, place, progress.merged);
  },
  mergeUnits = async (store: RunStore): Promise<StepOutcome> => {
    const { unitBase, unitHome } = store.current(),
      integration = path.join(unitHome, "INTEGRATION"),
      dir = path.join(store.dir, "units");
    await removeWorktree(integration);
    await addWorktree(integration, unitBase);
    await makeDir(dir);
    return mergeInto(store, { dir, integration });
  };

export { mergeUnits };
