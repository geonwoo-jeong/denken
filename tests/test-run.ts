// A test's tools for its run: the engine's commands, the loop, and what the fake agents logged.
import type { Place, Ran, TestRun } from "./test-types.ts";
import { argsOf, callsOf, linesOf, stateOf } from "./test-log.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { SCRIPTS } from "./test-paths.ts";
import { driveFrom } from "./test-drive.ts";
import path from "node:path";
import { run } from "./test-process.ts";

const FIRST_ATTEMPT = 1,
  FIRST_ROUND = 0,
  // Units: folders a/ and b/ in the project, committed, and DENKEN's split in units.md.
  splitInto = async (place: Place, runPath: string, units: string): Promise<void> => {
    const where = { cwd: place.proj, env: place.env };
    await mkdir(path.join(place.proj, "a"), { recursive: true });
    await mkdir(path.join(place.proj, "b"), { recursive: true });
    await writeFile(path.join(place.proj, "a", "keep.txt"), "a\n");
    await writeFile(path.join(place.proj, "b", "keep.txt"), "b\n");
    await run("git", ["add", "."], where);
    await run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "folders"], where);
    await writeFile(path.join(place.proj, runPath, "units.md"), `# Units\n\n${units}`);
  },
  worktreesIn = async (place: Place): Promise<number> => {
    const listed = await run("git", ["worktree", "list", "--porcelain"], { cwd: place.proj, env: place.env });
    return listed.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length;
  },
  commandsFor = (place: Place): Pick<TestRun, "denken" | "node" | "sh"> => {
    const where = { cwd: place.proj, env: place.env },
      node = async (script: string, ...args: readonly string[]): Promise<Ran> => {
        const result = await run(process.execPath, [path.join(SCRIPTS, script), ...args], where);
        return result;
      };
    return {
      denken: async (...args) => {
        const result = await node("denken.ts", ...args);
        return result;
      },
      node,
      sh: async (command, ...args) => {
        const result = await run(command, args, where);
        return result;
      },
    };
  },
  runTools = (place: Place, runPath: string): TestRun => {
    const commands = commandsFor(place);
    return Object.assign(structuredClone({ dir: place.dir, env: place.env, proj: place.proj, run: runPath, scenarioPath: place.scenarioPath }), commands, {
      argsOf: async (key: string, attempt = FIRST_ATTEMPT) => {
        const args = await argsOf(place, key, attempt);
        return args;
      },
      calls: async () => {
        const calls = await callsOf(place);
        return calls;
      },
      callsFull: async () => {
        const lines = await linesOf(`${place.scenarioPath}.log`);
        return lines;
      },
      drive: async (options = {}) => {
        const end = await driveFrom(commands.denken, runPath, { options, round: FIRST_ROUND });
        return end;
      },
      split: async (units: string) => {
        await splitInto(place, runPath, units);
      },
      state: async () => {
        const state = await stateOf(place, runPath);
        return state;
      },
      worktrees: async () => {
        const count = await worktreesIn(place);
        return count;
      },
    });
  };

export { runTools };
