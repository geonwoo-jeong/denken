/*
 * The units' git worktrees. Units are built in worktrees outside the project, so the project's own
 * tools (test runners, tsc, linters) never pick them up, and each unit's agents are confined to theirs.
 */
import { EXCLUDE, ROOT } from "./paths.ts";
import { eachInOrder, mapInOrder } from "./lists.ts";
import { exists, removePath } from "./files.ts";
import { gitAt, gitText } from "./git.ts";
import type { RunState } from "./types-run.ts";
import { envText } from "./env.ts";
import { fail } from "./output.ts";
import { homedir } from "node:os";
import path from "node:path";

const WORKTREES = envText("DENKEN_WORKTREES") || path.join(envText("XDG_CACHE_HOME") || path.join(homedir(), ".cache"), "denken", "worktrees"),
  /*
   * Dependencies installed in the project, linked one level above the units' worktrees, where
   * module resolution finds them and git in the worktree does not see them.
   */
  SHARED_DEPS: readonly string[] = ["node_modules"],
  plumbingEnv = (index: string): Readonly<Record<string, string>> => ({
    GIT_AUTHOR_EMAIL: "denken@localhost",
    GIT_AUTHOR_NAME: "DENKEN",
    GIT_COMMITTER_EMAIL: "denken@localhost",
    GIT_COMMITTER_NAME: "DENKEN",
    GIT_INDEX_FILE: index,
  }),
  // The project as it is now, uncommitted and untracked files included, in a temporary index.
  indexProject = async (head: string, env: Readonly<Record<string, string>>): Promise<void> => {
    const steps: readonly (readonly string[])[] = [["read-tree", head], ["add", "-A", "--", ".", ...EXCLUDE]];
    await mapInOrder(steps, async (step) => {
      const [name = ""] = step,
        result = await gitAt(ROOT, step, { env });
      if (!result.ok) {
        fail(`could not record the project for the units (git ${name}): ${result.err}`);
      }
      return result;
    });
  },
  /*
   * The commit every unit starts from: the project as it is now, built with plumbing (a temporary
   * index, write-tree, commit-tree), so no hook runs and no branch, index or working file changes.
   */
  commitIndex = async (runDir: string, head: string): Promise<string> => {
    const env = plumbingEnv(path.join(runDir, "base.index")),
      tree = await gitAt(ROOT, ["write-tree"], { env }),
      commit = await gitAt(ROOT, ["-c", "commit.gpgSign=false", "commit-tree", tree.text, "-p", head, "-m", `DENKEN base for ${path.basename(runDir)}`], { env });
    if (!commit.ok) {
      fail(`could not record the project for the units: ${commit.err}`);
    }
    return commit.text;
  },
  unitBaseCommit = async (runDir: string): Promise<string> => {
    const head = await gitText(["rev-parse", "-q", "--verify", "HEAD"]),
      index = path.join(runDir, "base.index");
    if (!head) {
      fail("parallel units start from a commit: commit once, or remove units.md to run the request as one");
    }
    await removePath(index);
    try {
      await indexProject(head, plumbingEnv(index));
      return await commitIndex(runDir, head);
    } finally {
      await removePath(index);
    }
  },
  addWorktree = async (target: string, commit: string): Promise<void> => {
    const added = await gitAt(ROOT, ["worktree", "add", "--detach", target, commit]);
    if (!added.ok) {
      fail(`git worktree add failed for ${target}: ${added.err}`);
    }
    // A locked worktree survives "git worktree prune" while its unit works in it.
    await gitAt(ROOT, ["worktree", "lock", "--reason", "DENKEN unit in progress", target]);
  },
  removeWorktree = async (target: string): Promise<void> => {
    if (await exists(target)) {
      await gitAt(ROOT, ["worktree", "remove", "--force", "--force", target]);
    }
    await removePath(target);
  },
  tearDownUnits = async (state: RunState): Promise<void> => {
    await eachInOrder(state.units, async (unit) => {
      await removeWorktree(unit.root);
    });
    if (state.unitHome) {
      await removeWorktree(path.join(state.unitHome, "INTEGRATION"));
    }
    await gitAt(ROOT, ["worktree", "prune"]);
  };

export { addWorktree, removeWorktree, SHARED_DEPS, tearDownUnits, unitBaseCommit, WORKTREES };
