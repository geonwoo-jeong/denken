/*
 * Git, run so that no repository setting can run a program, and always on the repository the
 * engine runs in: GIT_DIR and the like, inherited from a git hook for example, would point its
 * git commands at another repository. No fsmonitor, no hooks, no external diff drivers or textconv.
 */
import type { GitOptions, GitResult } from "./types-io.ts";
import { entriesOf, unique } from "./lists.ts";
import { ROOT } from "./paths.ts";
import { environment } from "./env.ts";
import { groupOf } from "./text.ts";
import { runProcess } from "./processes.ts";

const SUCCESS = 0,
  LOCATION = /^GIT_(?:ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|COMMON_DIR|DIR|INDEX_FILE|NAMESPACE|OBJECT_DIRECTORY|PREFIX|WORK_TREE)$/u,
  DRIVER = /^filter\.(?<driver>.+)\.[^.\s]+\s/u,
  SAFE: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"],
  gitEnv = (): Readonly<Record<string, string>> => Object.fromEntries(entriesOf(environment()).filter(([key]) => !LOCATION.test(key))),
  safeArgs = (args: readonly string[]): readonly string[] => {
    const [first, ...rest] = args;
    if (first === "diff") {
      return [...SAFE, "diff", "--no-ext-diff", "--no-textconv", ...rest];
    }
    return [...SAFE, ...args];
  },
  // Stdout of a git command in the project, binary safe; empty when it failed.
  gitBinary = async (args: readonly string[]): Promise<string> => {
    const result = await runProcess("git", safeArgs(args), { cwd: ROOT, env: gitEnv() });
    if (result.status === SUCCESS) {
      return result.bytes;
    }
    return "";
  },
  gitText = async (args: readonly string[]): Promise<string> => {
    const result = await runProcess("git", safeArgs(args), { cwd: ROOT, env: gitEnv() });
    if (result.status === SUCCESS) {
      return result.stdout.trim();
    }
    return "";
  },
  gitLines = async (args: readonly string[]): Promise<readonly string[]> => {
    const text = await gitText(args);
    return text.split("\n").filter(Boolean);
  },
  // Filter drivers named in the repository config: a unit's agents share the repository's .git.
  filterDrivers = async (): Promise<readonly string[]> => {
    const lines = await gitLines(["config", "--get-regexp", String.raw`^filter\.`]);
    return unique(lines.map((line) => groupOf(DRIVER, line, "driver")).filter(Boolean));
  },
  // Every filter driver in the repository config, switched off for one command.
  filtersOff = async (args: readonly string[]): Promise<readonly string[]> => {
    const drivers = await filterDrivers(),
      off = drivers.flatMap((driver) => ["-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.smudge=`, "-c", `filter.${driver}.process=`, "-c", `filter.${driver}.required=false`]);
    return [...SAFE, ...off, ...safeArgs(args).slice(SAFE.length)];
  },
  /*
   * Git in a given directory, for the work on units (worktrees, patches, the base commit), with
   * the same protections, and with every filter driver in the repository config switched off.
   */
  gitAt = async (dir: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> => {
    const result = await runProcess("git", await filtersOff(args), { cwd: dir, env: Object.assign(gitEnv(), options.env), input: options.input ?? "" });
    return { err: result.stderr.trim(), ok: result.status === SUCCESS, out: result.bytes, text: result.stdout.trim() };
  },
  // Stdout of a git command for the guard's snapshot: no filter driver runs while the guard looks.
  gitGuardBinary = async (args: readonly string[]): Promise<string> => {
    const result = await runProcess("git", await filtersOff(args), { cwd: ROOT, env: gitEnv() });
    if (result.status === SUCCESS) {
      return result.bytes;
    }
    return "";
  };

export { gitAt, gitBinary, gitGuardBinary, gitLines, gitText };
