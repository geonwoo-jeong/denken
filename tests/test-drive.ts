// The loop a test drives the run with: next, again and again, until the run needs DENKEN or is done.
import type { DriveOptions, JsonValue, Ran } from "./test-types.ts";
import { MISSING, textAt } from "./test-json.ts";
import assert from "node:assert/strict";

type Denken = (...args: readonly string[]) => Promise<Ran>;

// Where the loop is: how it drives, and how many rounds it has taken.
interface Round {
  readonly options: DriveOptions;
  readonly round: number;
}

// One round's answer, and how the loop drives.
interface Turn {
  readonly next: Ran;
  readonly options: DriveOptions;
}

const DRIVE_ROUNDS = 20,
  WAIT_SEC = "60",
  STEP = 1,
  // Drive confirms the TODO lists on the user's behalf unless told not to.
  confirmed = async (denken: Denken, runPath: string, turn: Turn): Promise<boolean> => {
    if (turn.options.autoConfirm === false || textAt(turn.next.json, "reason") !== "confirm_todos") {
      return false;
    }
    const confirm = await denken("confirm", runPath, "--user-said", "Looks good, go ahead.");
    assert.equal(textAt(confirm.json, "action"), "confirmed");
    return true;
  },
  driveFrom = async (denken: Denken, runPath: string, from: Round): Promise<JsonValue | symbol> => {
    const next = await denken("next", runPath, "--wait", WAIT_SEC);
    if (next.json === MISSING || from.round >= DRIVE_ROUNDS) {
      throw new Error(`next printed no JSON, or the run did not settle (exit ${next.status}): ${next.stdout}${next.stderr}`);
    }
    if ((await confirmed(denken, runPath, { next, options: from.options })) || textAt(next.json, "action") === "running") {
      return driveFrom(denken, runPath, { options: from.options, round: from.round + STEP });
    }
    return next.json;
  };

export { driveFrom };
