/*
 * The units' patches, each against the common base (so commits an agent made are included), applied
 * together in an integration worktree first. The first one that does not apply stops the merge.
 */
import type { Conflict, MergeProgress, MergedUnit } from "./types-units.ts";
import { NONE, mapInOrder } from "./lists.ts";
import { EXCLUDE } from "./paths.ts";
import type { RunStore } from "./types-store.ts";
import type { UnitEntry } from "./types-progress.ts";
import { gitAt } from "./git.ts";
import path from "node:path";
import { writeBinary } from "./files.ts";

// Where the merge works: the integration worktree, and the folder the patches are kept in.
interface MergePlace {
  readonly dir: string;
  readonly integration: string;
}

// A unit's patch: its file, whether it is empty, and what it merges.
interface TakenPatch {
  readonly empty: boolean;
  readonly file: string;
  readonly merged: MergedUnit;
}

const NO_CONFLICT: Conflict = { error: "", patch: "", unit: "" },
  // The unit's changes against the base: the patch file, the files it touches, and whether its agent committed.
  readPatch = async (base: string, unit: UnitEntry, dir: string): Promise<TakenPatch> => {
    const file = path.join(dir, `${unit.id}.patch`),
      patch = await gitAt(unit.root, ["diff", "--cached", "--binary", base, "--", ".", ...EXCLUDE]),
      names = await gitAt(unit.root, ["diff", "--cached", "--name-only", base, "--", ".", ...EXCLUDE]),
      head = await gitAt(unit.root, ["rev-parse", "HEAD"]);
    await writeBinary(file, patch.out);
    return { empty: patch.out.length === NONE, file, merged: { committed: head.text !== base, files: names.text.split("\n").filter(Boolean), unit: unit.id } };
  },
  // Everything in the unit's worktree is staged first, so its patch holds new files too.
  takePatch = async (store: RunStore, unit: UnitEntry, dir: string): Promise<TakenPatch> => {
    await gitAt(unit.root, ["add", "-A", "--", ".", ...EXCLUDE]);
    return readPatch(store.current().unitBase, unit, dir);
  },
  applyChecked = async (dir: string, unit: string, file: string): Promise<Conflict> => {
    const applied = await gitAt(dir, ["apply", "--binary", file]);
    if (!applied.ok) {
      return { error: applied.err, patch: file, unit };
    }
    return NO_CONFLICT;
  },
  // A patch applied in a directory, checked first: a conflict when either step fails.
  applyPatch = async (dir: string, unit: string, file: string): Promise<Conflict> => {
    const check = await gitAt(dir, ["apply", "--check", "--binary", file]);
    if (!check.ok) {
      return { error: check.err, patch: file, unit };
    }
    return applyChecked(dir, unit, file);
  },
  writeCombined = async (integration: string, base: string, file: string): Promise<string> => {
    const combined = await gitAt(integration, ["diff", "--cached", "--binary", base, "--", "."]);
    await writeBinary(file, combined.out);
    return combined.out;
  },
  // The units' changes together, as one patch against the base.
  combine = async (store: RunStore, place: MergePlace): Promise<string> => {
    await gitAt(place.integration, ["add", "-A", "--", "."]);
    return writeCombined(place.integration, store.current().unitBase, path.join(place.dir, "merged.patch"));
  },
  mergeOne = async (store: RunStore, unit: UnitEntry, place: MergePlace): Promise<MergeProgress> => {
    const taken = await takePatch(store, unit, place.dir);
    if (taken.empty) {
      return { conflict: NO_CONFLICT, merged: [taken.merged] };
    }
    return { conflict: await applyPatch(place.integration, unit.id, taken.file), merged: [taken.merged] };
  },
  applyUnits = async (store: RunStore, place: MergePlace): Promise<MergeProgress> => {
    let conflict = NO_CONFLICT;
    const merged = await mapInOrder(store.current().units, async (unit): Promise<readonly MergedUnit[]> => {
      if (conflict.unit) {
        return [];
      }
      const done = await mergeOne(store, unit, place);
      ({ conflict } = done);
      return done.merged;
    });
    return { conflict, merged: merged.flat() };
  };

export { applyPatch, applyUnits, combine, NO_CONFLICT };
