// What the development stage has changed, and what changed between two moments.
import { EMPTY_TREE, EXCLUDE, ROOT } from "./paths.ts";
import type { Stage, Tree } from "./types-names.ts";
import { mapAsync, unique } from "./lists.ts";
import type { RunState } from "./types-run.ts";
import type { StageChanges } from "./types-work.ts";
import { gitLines } from "./git.ts";
import { hashFile } from "./files.ts";
import path from "node:path";

const hashOf = async (file: string): Promise<string> => {
    const hash = await hashFile(path.join(ROOT, file));
    return hash;
  },
  /*
   * Files changed since a stage began: tracked changes against its base, plus untracked files that
   * did not exist when it began.
   */
  stageChanges = async (state: RunState, stage: Stage): Promise<StageChanges> => {
    const before = state.untrackedAtStage[stage],
      untrackedNow = await gitLines(["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE]),
      tracked = await gitLines(["diff", "--name-only", state.stageBase[stage] || EMPTY_TREE, "--", ".", ...EXCLUDE]),
      untracked = untrackedNow.filter((file) => !before.includes(file));
    return { changed: unique([...tracked, ...untracked]), untracked };
  },
  /*
   * The files this stage has changed, each with a hash of its content ("missing" once deleted).
   * Comparing two of these tells which files changed in between, reverts included.
   */
  changeTree = async (state: RunState): Promise<Tree> => {
    const { changed } = await stageChanges(state, "dev"),
      hashes = await mapAsync(changed, hashOf);
    return Object.fromEntries(changed.map((file, index) => [file, hashes[index] ?? ""]));
  },
  // A file missing from the older tree was as the stage began; it changed if it differs now.
  changedSince = async (state: RunState, tree: Tree): Promise<readonly string[]> => {
    const current = await changeTree(state),
      files = unique([...Object.keys(current), ...Object.keys(tree)]),
      hashes = await mapAsync(files, hashOf);
    return files.filter((file, index) => !Object.hasOwn(tree, file) || hashes[index] !== tree[file]).toSorted();
  };

export { changedSince, changeTree, stageChanges };
