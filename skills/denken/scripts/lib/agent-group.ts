/*
 * An agent CLI's process group: every process it started, stopped together. Each agent CLI leads
 * its own group, so the test runners, servers and shells it starts can be stopped with it. Signals
 * go to the whole group (negative pid).
 */
import { NONE, decrement } from "./lists.ts";
import { groupAlive, runProcess, signalGroup, sleep } from "./processes.ts";
import { ROOT } from "./paths.ts";
import { readTextOr } from "./files.ts";

const STOP_TRIES = 30,
  STOP_POLL_MS = 100,
  isGroup = (pgid: number): boolean => Number.isInteger(pgid) && pgid > NONE,
  waitGone = async (pgid: number, tries: number): Promise<void> => {
    if (tries <= NONE || !groupAlive(pgid)) {
      return;
    }
    await sleep(STOP_POLL_MS);
    await waitGone(pgid, decrement(tries));
  },
  // TERM first, then KILL for whatever is still there after three seconds.
  stopGroup = async (pgid: number): Promise<void> => {
    if (!isGroup(pgid) || !groupAlive(pgid)) {
      return;
    }
    signalGroup(pgid, "SIGTERM");
    await waitGone(pgid, STOP_TRIES);
    signalGroup(pgid, "SIGKILL");
  },
  commandOf = async (pgid: number): Promise<string> => {
    const result = await runProcess("ps", ["-o", "command=", "-p", String(pgid)], { cwd: ROOT });
    return result.stdout;
  },
  stopIfOurs = async (pgid: number, provider: string): Promise<void> => {
    const command = await commandOf(pgid);
    if (command.includes(provider)) {
      await stopGroup(pgid);
    }
  },
  // Stop a group only if its leader is still the agent CLI we started, never a reused pid.
  stopCallGroup = async (base: string, provider: string): Promise<void> => {
    const pgid = Number(await readTextOr(`${base}.cli.pid`, "0"));
    if (isGroup(pgid)) {
      await stopIfOurs(pgid, provider);
    }
  };

export { isGroup, stopCallGroup, stopGroup };
