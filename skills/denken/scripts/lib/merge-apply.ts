// The combined patch applied to the project, after the project's state before it is taken.
import { BLOCKED, MERGED } from "./step-outcomes.ts";
import type { Conflict, MergedUnit, StepOutcome } from "./types-units.ts";
import { EMPTY_TREE, EXCLUDE, ROOT } from "./paths.ts";
import { NO_CONFLICT, applyPatch } from "./merge-patches.ts";
import { gitLines, gitText } from "./git.ts";
import type { RunStore } from "./types-store.ts";
import { block } from "./blocks.ts";
import { finishMerge } from "./merge-finish.ts";
import { oneLine } from "./text.ts";

// The combined patch (empty when the units changed nothing), its file, and what each unit merged.
interface Combined {
  readonly file: string;
  readonly merged: readonly MergedUnit[];
  readonly patch: string;
}

const ERROR_MAX = 800,
  conflictOutcome = (store: RunStore, conflict: Conflict): StepOutcome => {
    block(store, "user", {
      info: { error: oneLine(conflict.error, ERROR_MAX), patch: conflict.patch, resolveWith: "retry", stage: "units", unit: conflict.unit },
      reason: "merge_conflict",
    });
    return BLOCKED;
  },
  // The project before the merge is where the merged change is measured from.
  projectBase = async (): Promise<string> => {
    const stash = await gitText(["stash", "create"]),
      head = await gitText(["rev-parse", "-q", "--verify", "HEAD"]);
    return stash || head || EMPTY_TREE;
  },
  applyIfAny = async (merge: Combined): Promise<Conflict> => {
    if (!merge.patch) {
      return NO_CONFLICT;
    }
    const conflict = await applyPatch(ROOT, "all", merge.file);
    return conflict;
  },
  applyMerged = async (store: RunStore, merge: Combined): Promise<StepOutcome> => {
    const base = await projectBase(),
      untracked = await gitLines(["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE]),
      conflict = await applyIfAny(merge);
    if (conflict.unit) {
      return conflictOutcome(store, conflict);
    }
    await finishMerge(store, merge.merged, { base, untracked });
    return MERGED;
  };

export { applyMerged, conflictOutcome };
