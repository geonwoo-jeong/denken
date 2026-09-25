// A parent's units as it keeps them: reading a unit's run, and changing one entry.
import { NONE, STEP, patch } from "./lists.ts";
import { SCRIPT, STATE_FILE } from "./paths.ts";
import { asRecord, isRecord, parseJson, recordOf, textOf } from "./json.ts";
import type { JsonObject } from "./types-json.ts";
import type { UnitEntry } from "./types-progress.ts";
import { oneLine } from "./text.ts";
import path from "node:path";
import { readTextOr } from "./files.ts";
import { runProcess } from "./processes.ts";

const ERROR_MAX = 400,
  withUnit = (units: readonly UnitEntry[], id: string, changes: Readonly<Partial<UnitEntry>>): readonly UnitEntry[] =>
    units.map((unit) => {
      if (unit.id === id) {
        return patch(unit, changes);
      }
      return unit;
    }),
  // A unit's state.json as JSON: empty when it cannot be read.
  readUnit = async (unit: UnitEntry): Promise<JsonObject> => {
    const parsed = parseJson(await readTextOr(path.join(unit.run, STATE_FILE), ""));
    return asRecord(parsed.value);
  },
  // Steps a unit's run once, in its worktree; its printed action, or an error action.
  stepUnit = async (unit: UnitEntry): Promise<JsonObject> => {
    const result = await runProcess(process.execPath, [SCRIPT, "next", unit.run, "--wait", "0"], { cwd: unit.root }),
      parsed = parseJson(result.stdout);
    if (parsed.ok && isRecord(parsed.value)) {
      return parsed.value;
    }
    return { action: "error", error: `${unit.id}'s engine printed no result (exit ${result.status}): ${oneLine(result.stderr, ERROR_MAX)}` };
  },
  // A unit's status from the action its engine printed.
  statusOf = (action: JsonObject): string => {
    const name = textOf(action, "action");
    if (name === "done" || name === "aborted") {
      return name;
    }
    if (name === "running") {
      return "working";
    }
    return "waiting";
  },
  working = (status: string): number => {
    if (status === "working") {
      return STEP;
    }
    return NONE;
  },
  // A unit's answer to the user's first confirmation: empty when it confirmed, else why not.
  confirmUnit =
    (userSaid: string) =>
    async (unit: UnitEntry): Promise<string> => {
      const result = await runProcess(process.execPath, [SCRIPT, "confirm", unit.run, "--user-said", userSaid], { cwd: unit.root }),
        out = asRecord(parseJson(result.stdout).value);
      if (textOf(out, "action") === "confirmed") {
        return "";
      }
      return `${unit.id}: ${textOf(out, "error") || oneLine(result.stderr, ERROR_MAX)}`;
    },
  lastText = (unit: UnitEntry, key: string): string => textOf(unit.last, key),
  blockedSince = (state: JsonObject): string => textOf(recordOf(state, "blocked"), "since");

export { blockedSince, confirmUnit, lastText, readUnit, statusOf, stepUnit, withUnit, working };
