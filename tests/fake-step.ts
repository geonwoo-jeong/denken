/*
 * The scenario step a call plays: the scenario file ($FAKE_SCENARIO) maps a call's key to one step,
 * or to an array of steps for successive attempts of the same call. Each call is logged as
 * "<cli> <key> <ro|rw> <net|nonet|->", and its arguments as a line of <scenario>.args.jsonl.
 */
import type { JsonObject, JsonValue } from "./test-types.ts";
import { appendTo, readOr, writeTo } from "./fake-io.ts";
import { isList, isRecord, parsed } from "./test-json.ts";
import type { FakeCall } from "./fake-types.ts";

const NONE = 0,
  STEP = 1,
  recordOr = (value: JsonValue | symbol): JsonObject => {
    if (isRecord(value)) {
      return value;
    }
    return {};
  },
  // How many times this call has run, this one included; kept in <scenario>.counts.json.
  countOf = (value: JsonValue | undefined): number => {
    if (typeof value === "number") {
      return value;
    }
    return NONE;
  },
  attemptOf = async (call: FakeCall): Promise<number> => {
    const countsPath = `${call.scenarioPath}.counts.json`,
      counts = recordOr(parsed(await readOr(countsPath, "{}"))),
      attempt = countOf(counts[call.key]) + STEP,
      next = Object.assign(structuredClone(counts), { [call.key]: attempt });
    await writeTo(countsPath, JSON.stringify(next));
    return attempt;
  },
  logArgs = async (scenarioPath: string, entry: JsonObject): Promise<void> => {
    await appendTo(`${scenarioPath}.args.jsonl`, `${JSON.stringify(entry)}\n`);
  },
  modeOf = (call: FakeCall): string => {
    if (call.readOnly) {
      return "ro";
    }
    return "rw";
  },
  logCall = async (call: FakeCall, attempt: number): Promise<void> => {
    await appendTo(`${call.scenarioPath}.log`, `${call.cli} ${call.key} ${modeOf(call)} ${call.network}\n`);
    await logArgs(call.scenarioPath, { args: call.args, attempt, key: call.key });
  },
  // A re-warm of a seed is logged as its own kind of call.
  logRewarm = async (cli: string, scenarioPath: string, args: readonly string[]): Promise<void> => {
    await appendTo(`${scenarioPath}.log`, `${cli} rewarm\n`);
    await logArgs(scenarioPath, { args, attempt: STEP, key: "rewarm" });
  },
  // The step for this attempt: the entry itself, or its attempt's element; none is an empty step.
  stepOf = async (call: FakeCall, attempt: number): Promise<JsonObject> => {
    const scenario = recordOr(parsed(await readOr(call.scenarioPath, "{}"))),
      entry = scenario[call.key];
    if (isList(entry)) {
      return recordOr(entry.at(attempt - STEP) ?? {});
    }
    return recordOr(entry ?? {});
  };

export { attemptOf, logCall, logRewarm, stepOf };
