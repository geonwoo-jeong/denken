// A command for one unit goes through the parent run, which alone says where the unit lives.
import { loadState, runDirOf } from "./store.ts";
import { SCRIPT } from "./paths.ts";
import type { UnitEntry } from "./types-progress.ts";
import { constants } from "node:os";
import { entriesOf } from "./lists.ts";
import { exists } from "./files.ts";
import { fail } from "./output.ts";
import { framed } from "./text.ts";
import { once } from "node:events";
import { spawn } from "node:child_process";

const UNIT_COMMANDS: ReadonlySet<string> = new Set(["confirm", "deny", "grant", "levels", "retry", "rule", "secrets", "status"]),
  VALUE_OFFSET = 1,
  FAILURE = 1,
  // A process a signal ended exits, as a shell reports it, with 128 plus the signal's number.
  SIGNAL_BASE = 128,
  signalExit = (signal: unknown): number => {
    const exits = entriesOf(constants.signals)
        .filter(([name]) => name === signal)
        .map(([, number]) => SIGNAL_BASE + number),
      [exit = FAILURE] = exits;
    return exit;
  },
  forUnit = (command: string, rest: readonly string[]): boolean => rest.includes("--unit") && UNIT_COMMANDS.has(command),
  exitOf = (closed: readonly unknown[]): number => {
    const [code, signal] = closed;
    if (typeof code === "number") {
      return code;
    }
    return signalExit(signal);
  },
  runInUnit = async (unit: UnitEntry, command: string, args: readonly string[]): Promise<void> => {
    const child = spawn(process.execPath, [SCRIPT, command, unit.run, ...args], { cwd: unit.root, stdio: "inherit" });
    process.exitCode = exitOf(await once(child, "close"));
  },
  // The command runs as the unit's own engine, in its worktree, without the --unit flag.
  forwardToUnit = async (command: string, runArg: string, rest: readonly string[]): Promise<void> => {
    const parent = await loadState(await runDirOf(runArg)),
      at = rest.indexOf("--unit"),
      id = rest[at + VALUE_OFFSET] ?? "",
      unit = parent.units.find((entry) => entry.id === id) ?? fail(`${id || "(none)"} is not a unit of this run${framed("; its units are ", parent.units.map((entry) => entry.id).join(", "), "")}`);
    if (!(await exists(unit.run))) {
      fail(`${unit.id}'s worktree is gone: the units were merged, or the run was cleaned up`);
    }
    await runInUnit(unit, command, rest.filter((_arg, index) => index !== at && index !== at + VALUE_OFFSET));
  };

export { forUnit, forwardToUnit };
