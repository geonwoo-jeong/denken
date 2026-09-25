// Git, run so that no repository setting can run a program, and always on the repository the engine runs in.
import { spawnSync } from "node:child_process";
import { ROOT } from "./core.mjs";

// The engine runs git outside any sandbox, so it never lets repository config run programs:
// no fsmonitor, no hooks, and no external diff drivers or textconv filters. It always works on the
// repository it runs in: GIT_DIR and the like, inherited from a git hook for example, would point
// its git commands at another repository.
export const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES)$/.test(k)));

export function git(...args) {
  const safe = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...(args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args)];
  const r = spawnSync("git", safe, { cwd: ROOT, env: GIT_ENV, maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : Buffer.alloc(0);
}

export const gitText = (...args) => git(...args).toString("utf8").trim();

// Git in a given directory for the work on units (worktrees, patches, the base commit), with the
// same protections, and with every filter driver in the repository config switched off: a unit's
// agents share the repository's .git, so a driver there is not trusted to run.
export function gitAt(dir, args, { env = {}, input } = {}) {
  const drivers = new Set(gitText("config", "--get-regexp", "^filter\\.").split("\n").map((l) => l.match(/^filter\.(.+)\.[^.\s]+\s/)?.[1]).filter(Boolean));
  const off = [...drivers].flatMap((d) => ["-c", `filter.${d}.clean=`, "-c", `filter.${d}.smudge=`, "-c", `filter.${d}.process=`, "-c", `filter.${d}.required=false`]);
  const safe = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...off, ...(args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args)];
  const r = spawnSync("git", safe, { cwd: dir, env: { ...GIT_ENV, ...env }, input, maxBuffer: 1 << 30 });
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0), err: (r.stderr ?? "").toString("utf8").trim() };
}
