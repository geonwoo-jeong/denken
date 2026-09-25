// Shared steps of the planning and ticking tests: a started run, its files, the engine's gaps, and the lists as text.
import type { JsonObject, JsonValue, TestRun } from "./test-types.ts";
import { listAt, parsed, textAt } from "./test-json.ts";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";

const READ_LIST = /- Read:\n(?<files>(?: {2}- .+\n)+)/u,
  // A test run that has been started, so the next step is to drive it.
  startedRun = async (scenario: JsonObject = {}): Promise<TestRun> => {
    const run = await setup(scenario);
    await run.denken("start", run.run);
    return run;
  },
  // A file of the run directory, as text; empty when it does not exist.
  runText = async (run: TestRun, ...parts: readonly string[]): Promise<string> => {
    const text = await readOr(path.join(run.proj, run.run, ...parts), "");
    return text;
  },
  // A file of the run's record under ai-log, as text.
  logText = async (run: TestRun, ...parts: readonly string[]): Promise<string> => {
    const state = await run.state(),
      text = await readOr(path.join(run.proj, textAt(state, "log"), ...parts), "");
    return text;
  },
  // The findings of the engine's review file for a call (calls/<call>.gaps.json).
  gapsOf = async (run: TestRun, call: string): Promise<readonly JsonValue[]> => {
    const text = await runText(run, "calls", `${call}.gaps.json`);
    return listAt(parsed(text), "findings");
  },
  // The text values of the list at a path, other values left out.
  textsAt = (value: JsonValue | symbol, ...keys: readonly (number | string)[]): readonly string[] =>
    listAt(value, ...keys).filter((item): item is string => typeof item === "string"),
  // The lines a prompt lists under "- Read:"; empty when it lists none.
  readList = (prompt: string): string => {
    const match = READ_LIST.exec(prompt);
    if (match === null) {
      return "";
    }
    return (match.groups ?? {})["files"] ?? "";
  },
  // The file names a call's prompt lists under "- Read:".
  readsOf = async (run: TestRun, call: string): Promise<readonly string[]> => {
    const prompt = await runText(run, "calls", `${call}.prompt.md`);
    return readList(prompt)
      .split("\n")
      .filter(Boolean)
      .map((line) => path.basename(line));
  };

export { gapsOf, logText, readsOf, runText, startedRun, textsAt };
