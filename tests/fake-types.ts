// The fake agent CLI's shapes: the call it was started for, and the answer it gives.
import type { JsonObject } from "./test-types.ts";

/*
 * A call as the fake reads it from its command line and prompt: which CLI it plays, the call's key
 * in the scenario ("<unit>:<stage>-<role>-<round>"), its run, and how its sandbox was set.
 */
interface FakeCall {
  readonly args: readonly string[];
  readonly callId: string;
  readonly cli: string;
  readonly devFile: string;
  readonly key: string;
  readonly network: string;
  readonly prompt: string;
  readonly readOnly: boolean;
  readonly request: string;
  readonly role: string;
  readonly round: string;
  readonly runDir: string;
  readonly scenarioPath: string;
  readonly seedFor: string;
  readonly stage: string;
  readonly unit: string;
}

// What the fake was started with: which CLI it plays, its arguments, its prompt and its scenario file.
interface Started {
  readonly args: readonly string[];
  readonly cli: string;
  readonly prompt: string;
  readonly scenarioPath: string;
}

// A call and the scenario step it plays this attempt.
interface Played {
  readonly call: FakeCall;
  readonly step: JsonObject;
}

// A unit's TODO lists, as METHODE would write them.
interface Plan {
  readonly dev: string;
  readonly qa: string;
}

// The fake's final message: text, or the structured answer of a checker.
type Final = JsonObject | string;

export type { FakeCall, Final, Plan, Played, Started };
