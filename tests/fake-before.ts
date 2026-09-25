/*
 * What a step does before the call answers: wait (sleepMs), leave a stray process behind
 * (spawnLate), write a result from another attempt (staleMeta), tamper with a file (touch), or fail.
 */
import { appendTo, sleep, writeTo } from "./fake-io.ts";
import { at, isRecord, textAt } from "./test-json.ts";
import { numberAt, truthyAt } from "./fake-values.ts";
import type { JsonObject } from "./test-types.ts";
import type { Played } from "./fake-types.ts";
import path from "node:path";
import { spawn } from "node:child_process";

const STALE_WAIT_MS = 1000,
  FAILURE = 1,
  NONE = 0,
  // The delay as the stray process's code reads it; "undefined" (no delay) when the step gives none.
  delayText = (late: JsonObject): string => {
    const value = at(late, "afterMs");
    if (typeof value === "number") {
      return String(value);
    }
    return "undefined";
  },
  spawnFrom = (late: JsonObject): void => {
    const target = path.join(process.cwd(), textAt(late, "touch"));
    spawn(process.execPath, ["-e", `setTimeout(() => require("fs").appendFileSync(${JSON.stringify(target)}, "late\\n"), ${delayText(late)})`], { stdio: "ignore" }).unref();
  },
  // A background process that appends to a file later, like a stray dev server.
  spawnLate = (played: Played): void => {
    const late = at(played.step, "spawnLate");
    if (isRecord(late)) {
      spawnFrom(late);
    }
  },
  // A finished-looking result from some other attempt of this call, then the call keeps working.
  writeStale = async (played: Played): Promise<void> => {
    if (!truthyAt(played.step, "staleMeta")) {
      return;
    }
    await writeTo(path.join(played.call.runDir, "calls", `${played.call.callId}.meta.json`), JSON.stringify({ nonce: "earlier-attempt", status: "ok" }));
    await sleep(STALE_WAIT_MS);
  },
  inProject = (target: string): string => {
    if (path.isAbsolute(target)) {
      return target;
    }
    return path.join(process.cwd(), target);
  },
  // "$RUN" is the run directory, "$PROJ" the main project, where units are merged.
  touchFile = async (played: Played): Promise<void> => {
    const touch = textAt(played.step, "touch"),
      target = touch.replace("$RUN", played.call.runDir).replace("$PROJ", path.join(path.dirname(played.call.scenarioPath), "proj"));
    if (touch) {
      await appendTo(inProject(target), "tampered\n");
    }
  },
  // Returns whether the call failed: it then writes the text to stderr and exits with 1.
  before = async (played: Played): Promise<boolean> => {
    const fail = textAt(played.step, "fail");
    if (numberAt(played.step, "sleepMs") > NONE) {
      await sleep(numberAt(played.step, "sleepMs"));
    }
    spawnLate(played);
    await writeStale(played);
    await touchFile(played);
    if (fail) {
      process.stderr.write(fail);
      process.exitCode = FAILURE;
    }
    return Boolean(fail);
  };

export { before };
