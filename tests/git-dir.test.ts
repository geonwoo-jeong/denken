/*
 * DENKEN engine tests: an inherited GIT_DIR, as in a git hook, points neither the test harness nor the
 * engine at another repository. Shared setup is in helpers.ts.
 */
import type { JsonObject, JsonValue, Ran } from "./test-types.ts";
import { at, isRecord, textAt } from "./test-json.ts";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { SCRIPTS } from "./test-paths.ts";
import assert from "node:assert/strict";
import { inherited } from "./test-env.ts";
import path from "node:path";
import { run } from "./test-process.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";

// The project the harness set up: where it is, its run, and the environment its commands get.
interface Project {
  readonly env: Readonly<Record<string, string>>;
  readonly proj: string;
  readonly run: string;
}

const ROUNDS = 20,
  NEXT = 1,
  NO_OBJECTS = 0,
  OBJECT_DIR = /^[0-9a-f]{2}$/u,
  objectDirs = async (outer: string): Promise<number> => {
    const names = await readdir(path.join(outer, ".git", "objects"));
    return names.filter((name) => OBJECT_DIR.test(name)).length;
  },
  recordAt = (value: JsonValue | symbol, key: string): JsonObject => {
    const found = at(value, key);
    if (isRecord(found)) {
      return found;
    }
    return {};
  },
  // The environment the harness gave the project's commands, as the setup script printed it.
  envOf = (value: JsonValue | symbol): Readonly<Record<string, string>> => {
    const pairs: readonly (readonly [string, JsonValue])[] = Object.entries(recordAt(value, "env"));
    return Object.fromEntries(
      pairs.flatMap(([key, item]): (readonly [string, string])[] => {
        if (typeof item === "string") {
          return [[key, item]];
        }
        return [];
      }),
    );
  },
  // The harness, run with GIT_DIR pointing at the outer repository, as a pre-push hook would leave it.
  harnessProject = async (outer: string): Promise<Project> => {
    const made = await run(process.execPath, [path.join(import.meta.dirname, "git-dir-setup.ts")], { cwd: outer, env: Object.assign(inherited(), { GIT_DIR: path.join(outer, ".git") }) });
    return { env: envOf(made.json), proj: textAt(made.json, "proj"), run: textAt(made.json, "run") };
  },
  // The engine, handed GIT_DIR directly.
  engineFor =
    (project: Project, outer: string) =>
    async (...args: readonly string[]): Promise<Ran> => {
      const result = await run(process.execPath, [path.join(SCRIPTS, "denken.ts"), ...args], { cwd: project.proj, env: Object.assign(structuredClone(project.env), { GIT_DIR: path.join(outer, ".git") }) });
      return result;
    },
  driveEngine = async (engine: (...args: readonly string[]) => Promise<Ran>, runPath: string, left: number): Promise<string> => {
    const next = await engine("next", runPath, "--wait", "60");
    if (textAt(next.json, "reason") === "confirm_todos") {
      await engine("confirm", runPath, "--user-said", "Go.");
    }
    if (textAt(next.json, "action") === "done" || left <= NEXT) {
      return textAt(next.json, "action");
    }
    return driveEngine(engine, runPath, left - NEXT);
  },
  outerRepo = async (): Promise<string> => {
    const outer = await mkdtemp(path.join(tmpdir(), "denken-outer-"));
    await run("git", ["init", "-q"], { cwd: outer, env: inherited() });
    return outer;
  },
  inheritedGitDir = async (): Promise<void> => {
    const outer = await outerRepo(),
      before = await readFile(path.join(outer, ".git", "config"), "utf8"),
      project = await harnessProject(outer),
      engine = engineFor(project, outer),
      started = await engine("start", project.run);
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(await driveEngine(engine, project.run, ROUNDS), "done");
    assert.equal(await readFile(path.join(outer, ".git", "config"), "utf8"), before);
    assert.equal(await objectDirs(outer), NO_OBJECTS);
  };

await test("an inherited GIT_DIR (as in a git hook) does not point the tests or the engine at another repository", inheritedGitDir);
