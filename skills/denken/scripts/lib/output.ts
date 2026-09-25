// What the engine prints: one JSON value on stdout, and stopping with an error or a waiting action.
import { EngineError } from "./engine-error.ts";
import { toJson } from "./json.ts";

const print = (value: unknown): void => {
    process.stdout.write(`${toJson(value)}\n`);
  },
  // Stops the command: the entry point prints {action: "error", error} and exits with 1.
  fail: (message: string) => never = (message) => {
    throw new EngineError(message, { action: "error", error: message });
  },
  // Stops the command with an action for DENKEN (a needs_user, say), exiting with 1.
  stop: (message: string, action: Readonly<Record<string, unknown>>) => never = (message, action) => {
    throw new EngineError(message, action);
  };

export { fail, print, stop };
