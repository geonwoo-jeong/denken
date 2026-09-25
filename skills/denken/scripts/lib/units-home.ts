// Where a run's units live: a folder per run beside the other projects' units, with shared dependencies linked.
import { EXCLUDE, ROOT } from "./paths.ts";
import { SHARED_DEPS, WORKTREES, tearDownUnits, unitBaseCommit } from "./units-worktree.ts";
import { START, sha, slug } from "./text.ts";
import { exists, linkTo, makeDir, removePath } from "./files.ts";
import { gitAt, gitLines } from "./git.ts";
import type { RunStore } from "./types-store.ts";
import { block } from "./blocks.ts";
import { mapAsync } from "./lists.ts";
import path from "node:path";
import { projectPrint } from "./guard-snapshot.ts";

// The base commit the units start from, and the folder their worktrees go in.
interface UnitHome {
  readonly base: string;
  readonly home: string;
}

const HASH_PREFIX = 8,
  STATUS_MAX = 20,
  homeOf = (runDir: string): string =>
    path.join(WORKTREES, `${slug(path.basename(ROOT))}-${sha(ROOT).slice(START, HASH_PREFIX)}`, path.basename(runDir)),
  gitIgnores = async (name: string): Promise<boolean> => {
    const result = await gitAt(ROOT, ["check-ignore", "-q", name]);
    return result.ok;
  },
  // Dependencies installed in the project, when git ignores them, are linked above the worktrees.
  linkDeps = async (home: string): Promise<void> => {
    await mapAsync(SHARED_DEPS, async (dep) => {
      if ((await exists(path.join(ROOT, dep))) && (await gitIgnores(dep))) {
        await linkTo(path.join(ROOT, dep), path.join(home, dep));
      }
    });
  },
  /*
   * A fresh home for the units, and the commit they start from. The project must not change while
   * they work: its print now is what the merge checks it against.
   */
  /*
   * The units are merged into the project as it was when they started, so it must not change. A
   * change stops the run until the user says the project is as it should be.
   */
  mainChanged = async (store: RunStore): Promise<boolean> => {
    if ((await projectPrint(store.dir)) === store.current().mainPrint) {
      return false;
    }
    const status = await gitLines(["status", "--short", "--", ".", ...EXCLUDE]);
    block(store, "user", { info: { resolveWith: "retry", stage: "units", status: status.slice(START, STATUS_MAX) }, reason: "main_tree_changed" });
    return true;
  },
  prepareHome = async (store: RunStore): Promise<UnitHome> => {
    const home = homeOf(store.dir);
    await tearDownUnits(store.current());
    await removePath(home);
    await makeDir(home);
    await linkDeps(home);
    store.apply({ unitBase: await unitBaseCommit(store.dir), unitHome: home });
    store.apply({ mainPrint: await projectPrint(store.dir) });
    return { base: store.current().unitBase, home };
  };

export { mainChanged, prepareHome };
