// What a test reads back: the calls the fake agents logged, the arguments each got, and the run's state.
import type { JsonValue, Place } from "./test-types.ts";
import { MISSING, isRecord, listAt, parsed } from "./test-json.ts";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

const FIRST_FIELD = 0,
  LOGGED_FIELDS = 3,
  readOr = async (file: string, fallback: string): Promise<string> => {
    try {
      const text = await readFile(file, "utf8");
      return text;
    } catch {
      return fallback;
    }
  },
  linesOf = async (file: string): Promise<readonly string[]> => {
    const text = await readOr(file, "");
    return text.trim().split("\n").filter(Boolean);
  },
  // Log lines are "<cli> <call> <ro|rw> <net|nonet|->"; calls drops the network column.
  callsOf = async (place: Place): Promise<readonly string[]> => {
    const logged = await linesOf(`${place.scenarioPath}.log`);
    return logged.map((line) => line.split(" ").slice(FIRST_FIELD, LOGGED_FIELDS).join(" "));
  },
  // The arguments a call's attempt got.
  argsOf = async (place: Place, key: string, attempt: number): Promise<readonly string[]> => {
    const logged = await linesOf(`${place.scenarioPath}.args.jsonl`),
      entry = logged.map((line) => parsed(line)).find((value) => isRecord(value) && value["key"] === key && value["attempt"] === attempt) ?? MISSING;
    return listAt(entry, "args").filter((arg): arg is string => typeof arg === "string");
  },
  fileExists = async (file: string): Promise<boolean> => {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  },
  stateOf = async (place: Place, runPath: string): Promise<JsonValue | symbol> => {
    const text = await readOr(path.join(place.proj, runPath, "state.json"), "");
    return parsed(text);
  };

export { argsOf, callsOf, fileExists, linesOf, readOr, stateOf };
