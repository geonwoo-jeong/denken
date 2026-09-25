// What the level, seed and session tests share: flag values, argument shapes, record files, rulings and state edits.
import type { JsonObject, JsonValue, TestRun } from "./test-types.ts";
import { at, isRecord, listAt, parsed, textAt } from "./test-json.ts";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";

// A field to set: its key and its value.
interface Field {
  readonly key: string;
  readonly value: JsonValue;
}

const NEXT = 1,
  NONE_LEFT = 0,
  RULINGS_LEFT = 10,
  MS_PER_HOUR = 3_600_000,
  SESSION_FLAGS: ReadonlySet<string> = new Set(["--resume", "--session-id"]),
  FORK_FLAGS: ReadonlySet<string> = new Set(["--fork-session", "--resume"]),
  // The value given after a flag in a call's arguments.
  valueAfter = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + NEXT] ?? "",
  // A call's arguments without its own session ids: what a fork must share with its seed.
  shapeOf = (args: readonly string[]): readonly string[] =>
    args.filter((arg, index) => !SESSION_FLAGS.has(args[index - NEXT] ?? "") && !FORK_FLAGS.has(arg)),
  // The texts in the list at a path.
  textsAt = (value: JsonValue | symbol, ...keys: readonly string[]): readonly string[] =>
    listAt(value, ...keys).filter((item): item is string => typeof item === "string"),
  // A file of the run's record, in its ai-log folder.
  logText = async (project: TestRun, ...parts: readonly string[]): Promise<string> => {
    const state = await project.state(),
      text = await readFile(path.join(project.proj, textAt(state, "log"), ...parts), "utf8");
    return text;
  },
  // A file of the run's own directory, such as a call's prompt.
  runText = async (project: TestRun, ...parts: readonly string[]): Promise<string> => {
    const text = await readFile(path.join(project.proj, project.run, ...parts), "utf8");
    return text;
  },
  // The arguments a call's attempt got, as one line.
  argsLine = async (project: TestRun, key: string, attempt = NEXT): Promise<string> => {
    const args = await project.argsOf(key, attempt);
    return args.join(" ");
  },
  // Drives the run, upholding every ruling, until it is done; with expectRuling, every stop must be a ruling.
  upholdUntilDone = async (project: TestRun, expectRuling: boolean, left = RULINGS_LEFT): Promise<void> => {
    const end = await project.drive();
    if (textAt(end, "action") === "done") {
      return;
    }
    assert.ok(left > NONE_LEFT, "the run did not finish");
    if (expectRuling) {
      assert.equal(textAt(end, "action"), "needs_ruling", JSON.stringify(end));
    }
    await project.denken("rule", project.run, "--decision", "uphold", "--note", "Keep going.");
    await upholdUntilDone(project, expectRuling, left - NEXT);
  },
  // Rewrites state.json with one change: the parsed state is copied, changed, and written back.
  editState = async (project: TestRun, change: (state: JsonObject) => JsonObject): Promise<void> => {
    const file = path.join(project.proj, project.run, "state.json"),
      state = parsed(await readFile(file, "utf8"));
    if (!isRecord(state)) {
      throw new Error("state.json is not a JSON object");
    }
    await writeFile(file, JSON.stringify(change(state)));
  },
  hoursAgo = (hours: number): string => new Date(Date.now() - hours * MS_PER_HOUR).toISOString(),
  // The record at a path: an empty one when there is none.
  recordAt = (value: JsonValue | symbol, ...keys: readonly string[]): JsonObject => {
    const found = at(value, ...keys);
    if (isRecord(found)) {
      return found;
    }
    return {};
  },
  // A copy of an entry with one field set; an entry that is not a record stays as it is.
  withField = (item: JsonValue, field: Field): JsonValue => {
    if (!isRecord(item)) {
      return item;
    }
    return Object.assign(structuredClone(item), { [field.key]: field.value });
  },
  // A copy of a record with one field set in every entry.
  setInEach = (record: JsonObject, field: Field): JsonObject => {
    const entries: readonly (readonly [string, JsonValue])[] = Object.entries(record);
    return Object.fromEntries(entries.map(([name, item]) => [name, withField(item, field)]));
  },
  // A copy of a record with one field set in one entry.
  setIn = (record: JsonObject, name: string, field: Field): JsonObject => Object.assign(structuredClone(record), { [name]: withField(record[name] ?? {}, field) }),
  // The session id of the reviewers' seed.
  reviewerSeed = (state: JsonValue | symbol): string => {
    const seeds = recordAt(state, "seedSessions"),
      reviewer = Object.values(seeds).find((seed) => textAt(seed, "perspective") === "reviewer") ?? {};
    return textAt(reviewer, "sessionId");
  };

export { argsLine, editState, hoursAgo, logText, recordAt, reviewerSeed, runText, setIn, setInEach, shapeOf, textsAt, upholdUntilDone, valueAfter };
