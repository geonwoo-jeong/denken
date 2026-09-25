// The engine's commands, dispatched: a unit's through its parent, the others locked or open.
import { fail, print } from "./output.ts";
import { forUnit, forwardToUnit } from "./entry-unit.ts";
import { locked, lockedOr } from "./entry-lock.ts";
import { openStore, runDirOf } from "./store.ts";
import { LOCKED } from "./entry-locked.ts";
import { OPEN } from "./entry-open.ts";
import { advanceRun } from "./flow.ts";
import { cmdNew } from "./cmd-new.ts";
import { runExec } from "./exec.ts";
import { stopUnitRun } from "./parallel-abort.ts";

const MS_PER_SECOND = 1000,
  ABORT_WAIT_MS = 15_000,
  NO_WAIT = 0,
  VALUE_OFFSET = 1,
  USAGE = "usage: denken.ts <new|start|next|confirm|rule|retry|grant|deny|status|tick|request-permission> ...",
  waitOf = (rest: readonly string[]): number => {
    if (!rest.includes("--wait")) {
      return NO_WAIT;
    }
    return Number(rest[rest.indexOf("--wait") + VALUE_OFFSET]) || NO_WAIT;
  },
  runNext = async (runArg: string, rest: readonly string[]): Promise<void> => {
    const waitSec = waitOf(rest);
    await lockedOr(runArg, waitSec * MS_PER_SECOND, {
      busy: () => {
        print({ action: "running", busy: true, next: "Another DENKEN engine process is waiting on this run. Run next again with --wait." });
      },
      work: async (store) => {
        await advanceRun(store, waitSec);
      },
    });
  },
  // Stops a unit's run: its call, if one is running, and the run itself.
  runAbort = async (runArg: string): Promise<void> => {
    await lockedOr(runArg, ABORT_WAIT_MS, {
      busy: () => {
        fail("the unit's engine is busy");
      },
      work: async (store) => {
        await stopUnitRun(store);
        print({ action: "aborted" });
      },
    });
  },
  runOpen = async (command: string, runArg: string, rest: readonly string[]): Promise<void> => {
    const store = await openStore(await runDirOf(runArg)),
      handler = OPEN[command] ?? fail(USAGE);
    await handler(store, rest);
  },
  runCommand = async (command: string, runArg: string, rest: readonly string[]): Promise<void> => {
    const lockedCommand = LOCKED[command];
    if (forUnit(command, rest)) {
      await forwardToUnit(command, runArg, rest);
    } else if (command === "new") {
      await cmdNew(runArg);
    } else if (command === "next") {
      await runNext(runArg, rest);
    } else if (command === "_abort") {
      await runAbort(runArg);
    } else if (command === "_exec") {
      const [id = ""] = rest;
      await runExec(runArg, id);
    } else if (lockedCommand) {
      await locked(runArg, NO_WAIT, async (store) => {
        await lockedCommand(store, rest);
      });
    } else {
      await runOpen(command, runArg, rest);
    }
  };

export { runCommand };
