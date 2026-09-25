// What the development stage has changed, and what changed between two moments.
import { join } from "node:path";
import { EMPTY_TREE, EXCLUDE, hashFile, ROOT } from "./core.mjs";
import { gitText } from "./git.mjs";

// The files this stage has changed, each with a hash of its content ("missing" once deleted).
// Comparing two of these tells which files changed in between, reverts included.
export const changeTree = (state) => Object.fromEntries(stageChanges(state, "dev").changed.map((f) => [f, hashFile(join(ROOT, f))]));

export function changedSince(state, tree) {
  const current = changeTree(state);
  // A file missing from the older tree was as the stage began; it changed if it differs now.
  return [...new Set([...Object.keys(current), ...Object.keys(tree)])].filter((f) => (f in tree ? hashFile(join(ROOT, f)) !== tree[f] : true)).sort();
}

// Files changed since a stage began: tracked changes against its base, plus untracked files that
// did not exist when it began.
export function stageChanges(state, stage) {
  const lines = (text) => text.split("\n").filter(Boolean);
  const before = new Set(state.untrackedAtStage?.[stage] ?? []);
  const untracked = lines(gitText("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE)).filter((f) => !before.has(f));
  const changed = [...new Set([...lines(gitText("diff", "--name-only", state.stageBase[stage] || EMPTY_TREE, "--", ".", ...EXCLUDE)), ...untracked])];
  return { changed, untracked };
}
