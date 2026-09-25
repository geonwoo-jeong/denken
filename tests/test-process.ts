// Running a program from a test: its exit status, its output, and its stdout parsed as JSON.
import type { Ran } from "./test-types.ts";
import { once } from "node:events";
import { parsed } from "./test-json.ts";
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";

interface Where {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

const NO_STATUS = -1,
  statusOf = (closed: readonly unknown[]): number => {
    const [code] = closed;
    if (typeof code === "number") {
      return code;
    }
    return NO_STATUS;
  },
  ignoreInputError = (): void => {
    // A program that exits before reading its input breaks the pipe; its exit status says the rest.
  },
  resultOf = (finished: readonly [readonly unknown[], string, string]): Ran => {
    const [closed, stdout, stderr] = finished;
    return { json: parsed(stdout), status: statusOf(closed), stderr, stdout };
  },
  run = async (command: string, args: readonly string[], where: Where): Promise<Ran> => {
    const child = spawn(command, args, { cwd: where.cwd, env: where.env, stdio: "pipe" }),
      finished = Promise.all([once(child, "close"), text(child.stdout), text(child.stderr)]);
    child.stdin.on("error", ignoreInputError);
    child.stdin.end();
    return resultOf(await finished);
  };

export { run };
