// The agent CLI's process: started in its own process group, timed out, and stopped with everything it started.
import type { CliResult, CliRun } from "./types-work.ts";
import { codeOf, messageOf } from "./text.ts";
import { open, writeFile } from "node:fs/promises";
import { NO_STATUS } from "./processes.ts";
import { ROOT } from "./paths.ts";
import { setTimeout as delay } from "node:timers/promises";
import { environment } from "./env.ts";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { stopGroup } from "./agent-group.ts";

interface Exit {
  readonly error: string;
  readonly signal: string;
  readonly status: number;
}

const TIMED_OUT = "timed out",
  textOr = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    return "";
  },
  statusOr = (value: unknown): number => {
    if (typeof value === "number") {
      return value;
    }
    return NO_STATUS;
  },
  // How the CLI exited; a spawn error (the CLI missing, say) is an exit without status.
  exitOf = async (exited: Readonly<Promise<readonly unknown[]>>): Promise<Exit> => {
    try {
      const [code, signal] = await exited;
      return { error: "", signal: textOr(signal), status: statusOr(code) };
    } catch (error) {
      return { error: messageOf(error), signal: codeOf(error), status: NO_STATUS };
    }
  },
  ignoreStreamError = (): void => {
    // A CLI that exits before reading its prompt breaks the pipe; its exit status says the rest.
  },
  // Whether the time ran out before the CLI exited; when it did, the CLI's group is stopped.
  timedRace = async (exit: Readonly<Promise<Exit>>, pgid: number, timeoutMs: number): Promise<boolean> => {
    const stopper = new AbortController(),
      ended = async (): Promise<boolean> => {
        await exit;
        return false;
      },
      expired = async (): Promise<boolean> => {
        try {
          await delay(timeoutMs, TIMED_OUT, { signal: stopper.signal });
          return true;
        } catch {
          return false;
        }
      },
      timedOut = await Promise.race([ended(), expired()]);
    stopper.abort();
    if (timedOut) {
      await stopGroup(pgid);
    }
    return timedOut;
  },
  finishCli = async (exit: Readonly<Promise<Exit>>, pgid: number, timeoutMs: number): Promise<CliResult> => {
    const timedOut = await timedRace(exit, pgid, timeoutMs),
      result = await exit;
    await stopGroup(pgid);
    return { error: result.error, signal: result.signal, status: result.status, timedOut };
  },
  // The CLI's output (the streamed events and its errors) goes to the call's log.
  runCli = async (run: CliRun): Promise<CliResult> => {
    const log = await open(`${run.base}.log`, "w"),
      child = spawn(run.provider, run.args, { cwd: ROOT, detached: true, env: Object.assign(environment(), run.env), stdio: ["pipe", log.fd, log.fd] }),
      exit = exitOf(once(child, "exit"));
    await log.close();
    if (typeof child.pid === "number") {
      await writeFile(`${run.base}.cli.pid`, String(child.pid));
    }
    if (child.stdin !== null) {
      child.stdin.on("error", ignoreStreamError);
      child.stdin.end(run.input);
    }
    return finishCli(exit, child.pid ?? NO_STATUS, run.timeoutMs);
  };

export { runCli };
