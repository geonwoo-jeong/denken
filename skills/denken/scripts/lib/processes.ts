// Child processes: running a program to its end for its output, and signalling process groups.
import type { ProcessOptions, ProcessResult } from "./types-io.ts";
import { buffer } from "node:stream/consumers";
import { codeOf } from "./text.ts";
import { setTimeout as delay } from "node:timers/promises";
import { environment } from "./env.ts";
import { once } from "node:events";
import { spawn } from "node:child_process";

const NO_STATUS = -1,
  PROBE_SIGNAL = 0,
  DAY_MS = 86_400_000,
  statusOf = (closed: readonly unknown[]): number => {
    const [code] = closed;
    if (typeof code === "number") {
      return code;
    }
    return NO_STATUS;
  },
  ignoreStreamError = (): void => {
    // A program that exits before reading its input breaks the pipe; its exit status says the rest.
  },
  runProcess = async (command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> => {
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? environment(),
        signal: AbortSignal.timeout(options.timeoutMs ?? DAY_MS),
        stdio: "pipe",
      }),
      finished = Promise.all([once(child, "close"), buffer(child.stdout), buffer(child.stderr)]);
    child.stdin.on("error", ignoreStreamError);
    child.stdin.end(options.input ?? "");
    try {
      const [closed, out, err] = await finished;
      return { bytes: out.toString("latin1"), missing: false, status: statusOf(closed), stderr: err.toString("utf8"), stdout: out.toString("utf8") };
    } catch (error) {
      return { bytes: "", missing: codeOf(error) === "ENOENT", status: NO_STATUS, stderr: "", stdout: "" };
    }
  },
  pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, PROBE_SIGNAL);
      return true;
    } catch (error) {
      return codeOf(error) === "EPERM";
    }
  },
  // A signal to a whole process group (negative pid); false when there is no such group.
  signalGroup = (pgid: number, signal: NodeJS.Signals | typeof PROBE_SIGNAL): boolean => {
    try {
      process.kill(-pgid, signal);
      return true;
    } catch {
      return false;
    }
  },
  groupAlive = (pgid: number): boolean => signalGroup(pgid, PROBE_SIGNAL),
  sleep = async (ms: number): Promise<void> => {
    await delay(ms);
  };

export { groupAlive, NO_STATUS, pidAlive, runProcess, signalGroup, sleep };
