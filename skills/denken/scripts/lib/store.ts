// Finding a run's directory, and loading, holding and saving its state.json.
import { ROOT, STATE_FILE } from "./paths.ts";
import { exists, readTextOr, writeText } from "./files.ts";
import { isRecord, parseJson, toJson } from "./json.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { fail } from "./output.ts";
import { patch } from "./lists.ts";
import path from "node:path";

// The engine alone writes state.json, so its shape markers are enough to take it as a run's state.
const isRunState = (value: unknown): value is RunState =>
    isRecord(value) &&
    typeof value["version"] === "number" &&
    typeof value["task"] === "string" &&
    typeof value["stage"] === "string" &&
    isRecord(value["blocked"]) &&
    isRecord(value["inflight"]) &&
    isRecord(value["round"]),
  runDirOf = async (arg: string): Promise<string> => {
    if (!arg) {
      fail("missing <run> argument");
    }
    const dir = path.resolve(ROOT, arg);
    if (!(await exists(path.join(dir, STATE_FILE)))) {
      fail(`not a run directory: ${arg}`);
    }
    return dir;
  },
  loadState = async (dir: string): Promise<RunState> => {
    const file = path.join(dir, STATE_FILE),
      parsed = parseJson(await readTextOr(file, ""));
    if (parsed.ok && isRunState(parsed.value)) {
      return parsed.value;
    }
    return fail(`${file} is unreadable: ${parsed.error || "it is not a DENKEN run's state"}`);
  },
  makeStore = (dir: string, initial: RunState): RunStore => {
    let state = initial;
    return {
      apply: (changes) => {
        state = patch(state, changes);
        return state;
      },
      current: () => state,
      dir,
      save: async () => {
        await writeText(path.join(dir, STATE_FILE), `${toJson(state)}\n`);
      },
    };
  },
  openStore = async (dir: string): Promise<RunStore> => {
    const state = await loadState(dir);
    return makeStore(dir, state);
  },
  // A file of the run: its text, or empty when it does not exist.
  readRunFile = async (runDir: string, name: string): Promise<string> => {
    const text = await readTextOr(path.join(runDir, name), "");
    return text;
  };

export { isRunState, loadState, makeStore, openStore, readRunFile, runDirOf };
