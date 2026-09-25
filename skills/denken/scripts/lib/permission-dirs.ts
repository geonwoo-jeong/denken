/*
 * Directories a grant may open, by their real paths, so a symlink inside the project cannot point a
 * grant at the home directory: never / or a home, never where credentials or agent configuration
 * live, and outside the project only with the user's words.
 */
import { exists, realPath } from "./files.ts";
import { ROOT } from "./paths.ts";
import { envText } from "./env.ts";
import { fail } from "./output.ts";
import { mapAsync } from "./lists.ts";
import path from "node:path";

// Where a grant is checked from: the real home and project, and whether the user was asked.
interface Bounds {
  readonly home: string;
  readonly root: string;
  readonly userSaid: string;
}

const SENSITIVE: readonly string[] = [".ssh", ".aws", ".gnupg", ".config", ".claude", ".codex", ".kube", ".docker", ".netrc"],
  // On macOS a firmlink makes /System/Volumes/Data/Users/x the same folder as /Users/x.
  FIRMLINK = /^\/System\/Volumes\/Data(?=\/)/u,
  within = (dir: string, parent: string): boolean => dir === parent || dir.startsWith(`${parent}/`),
  // A folder's one real path: symlinks resolved, and the macOS data-volume prefix taken off.
  canonical = async (dir: string): Promise<string> => {
    const real = await realPath(dir);
    return real.replace(FIRMLINK, "");
  },
  realDir = async (dir: string): Promise<string> => {
    if (!(await exists(dir))) {
      fail(`${dir} does not exist`);
    }
    const real = await canonical(dir);
    return real;
  },
  checkDir = (dir: string, bounds: Bounds): void => {
    if (dir === "/" || dir === bounds.home || bounds.home.startsWith(`${dir}/`)) {
      fail(`refusing to grant ${dir}: it is a root or home directory`);
    }
    if (SENSITIVE.some((name) => within(dir, path.join(bounds.home, name)))) {
      fail(`refusing to grant ${dir}: it holds credentials or agent configuration`);
    }
    if (!within(dir, bounds.root) && !bounds.userSaid) {
      fail(`${dir} is outside the project; ask the user and pass their answer with --user-said '<verbatim>'`);
    }
  },
  homeOf = async (): Promise<string> => {
    const home = envText("HOME");
    if (home) {
      const real = await canonical(home);
      return real;
    }
    return "";
  },
  grantedDirs = async (dirs: readonly string[], userSaid: string): Promise<readonly string[]> => {
    const bounds = { home: await homeOf(), root: await canonical(ROOT), userSaid },
      real = await mapAsync(dirs, realDir);
    for (const dir of real) {
      checkDir(dir, bounds);
    }
    return real;
  };

export { canonical, grantedDirs };
