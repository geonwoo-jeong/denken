/*
 * One engine process per run. Claude Code moves a slow command to the background instead of
 * killing it, so without a lock two `next` processes could ingest or launch the same call. The lock
 * is a directory (mkdir is atomic), refreshed by a heartbeat. A lock whose heartbeat is older than
 * LOCK_STALE_MS is stale no matter what its pid is, so a reused pid cannot keep a dead run busy. A
 * stale lock is taken over by renaming it away, which only one process can do. A process that got a
 * signal stops changing the run at once, even while it still holds the lock.
 */
import { codeOf, now } from "./text.ts";
import { isRecord, numberOf, parseJson, textOf, toLine } from "./json.ts";
import { makeDir, modifiedAt, movePath, readTextOr, removePath, touch, writeText } from "./files.ts";
import { pidAlive, sleep } from "./processes.ts";
import { DENKEN_DIR } from "./paths.ts";
import { setTimeout as delay } from "node:timers/promises";
import { fail } from "./output.ts";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The lock this process holds: its directory, its nonce, and the heartbeat that keeps it fresh.
interface Held {
  readonly beating: Readonly<Promise<void>>;
  readonly dir: string;
  readonly kind: "held";
  readonly nonce: string;
  readonly stop: () => void;
}

interface NotHeld {
  readonly kind: "none";
}

interface Wanted {
  readonly deadline: number;
  readonly dir: string;
  readonly nonce: string;
}

// The owner file of a lock: found when it could be read as an owner, with the owner's pid.
interface Owner {
  readonly found: boolean;
  readonly nonce: string;
  readonly pid: number;
}

let held: Held | NotHeld = { kind: "none" },
  stopping = false;

const LOCK_STALE_MS = 30_000,
  // No owner file yet means another process is between mkdir and writing it.
  UNOWNED_STALE_MS = 2000,
  HEARTBEAT_MS = 5000,
  POLL_MS = 500,
  NO_PID = 0,
  BEAT = "beat",
  STALE = "stale",
  LIVE = "live",
  GONE = "gone",
  ownerFile = (dir: string): string => path.join(dir, "owner"),
  readOwner = async (dir: string): Promise<Owner> => {
    const parsed = parseJson(await readTextOr(ownerFile(dir), ""));
    if (parsed.ok && isRecord(parsed.value)) {
      return { found: true, nonce: textOf(parsed.value, "nonce"), pid: numberOf(parsed.value, "pid", NO_PID) };
    }
    return { found: false, nonce: "", pid: NO_PID };
  },
  ownerOf = async (current: Held | NotHeld): Promise<Owner> => {
    if (current.kind === "none") {
      return { found: false, nonce: "", pid: NO_PID };
    }
    const owner = await readOwner(current.dir);
    return owner;
  },
  ownsLock = async (): Promise<boolean> => {
    const current = held,
      owner = await ownerOf(current);
    return current.kind === "held" && owner.found && owner.nonce === current.nonce;
  },
  // Called straight from a signal listener, before any other code runs: from then on this process changes nothing.
  stopHolding = (): void => {
    stopping = true;
  },
  assertLock = async (): Promise<void> => {
    const owns = await ownsLock();
    if (stopping) {
      fail("this engine process was interrupted; stopping without changing anything");
    }
    if (!owns) {
      fail("this engine process lost the run lock (another process took the run over); stopping without changing anything");
    }
  },
  refresh = async (dir: string): Promise<void> => {
    try {
      await touch(dir);
    } catch {
      // The lock was removed or taken over; assertLock says so before anything is changed.
    }
  },
  // Holds the lock: its heartbeat refreshes it every few seconds until the lock is released.
  hold = (wanted: Wanted): void => {
    const stopper = new AbortController(),
      beat = async (): Promise<void> => {
        try {
          await delay(HEARTBEAT_MS, BEAT, { signal: stopper.signal });
        } catch {
          return;
        }
        await refresh(wanted.dir);
        await beat();
      };
    held = {
      beating: beat(),
      dir: wanted.dir,
      kind: "held",
      nonce: wanted.nonce,
      stop: (): void => {
        stopper.abort();
      },
    };
  },
  tryTake = async (wanted: Wanted): Promise<boolean> => {
    try {
      await mkdir(wanted.dir);
    } catch (error) {
      if (codeOf(error) !== "EEXIST") {
        throw error;
      }
      return false;
    }
    await writeText(ownerFile(wanted.dir), toLine({ nonce: wanted.nonce, pid: process.pid, since: now() }));
    hold(wanted);
    return true;
  },
  judgeAge = (age: number, owner: Owner): string => {
    if (age > LOCK_STALE_MS) {
      return STALE;
    }
    if (owner.found && owner.pid > NO_PID && pidAlive(owner.pid)) {
      return LIVE;
    }
    if (owner.found || age > UNOWNED_STALE_MS) {
      return STALE;
    }
    return LIVE;
  },
  // Whether a lock is stale, live, or gone (removed while it was looked at).
  staleness = async (dir: string): Promise<string> => {
    try {
      const age = Date.now() - (await modifiedAt(dir)),
        owner = await readOwner(dir);
      return judgeAge(age, owner);
    } catch {
      return GONE;
    }
  },
  bury = async (dir: string): Promise<void> => {
    const grave = `${dir}.stale-${randomUUID()}`;
    try {
      await movePath(dir, grave);
      await removePath(grave);
    } catch {
      // Another process took the stale lock over first.
    }
  },
  // A stale lock is buried; the state is returned either way.
  contest = async (dir: string): Promise<string> => {
    const state = await staleness(dir);
    if (state === STALE) {
      await bury(dir);
    }
    return state;
  },
  attempt = async (wanted: Wanted): Promise<boolean> => {
    if (await tryTake(wanted)) {
      return true;
    }
    const state = await contest(wanted.dir);
    if (state !== LIVE) {
      return attempt(wanted);
    }
    if (Date.now() >= wanted.deadline) {
      return false;
    }
    await sleep(POLL_MS);
    return attempt(wanted);
  },
  acquireLock = async (runDir: string, waitMs: number): Promise<boolean> => {
    const locks = path.join(DENKEN_DIR, "locks");
    await makeDir(locks);
    return attempt({ deadline: Date.now() + waitMs, dir: path.join(locks, `${path.basename(runDir)}.lock`), nonce: randomUUID() });
  },
  // Stops the heartbeat and removes the lock, if this process still holds it once the heartbeat has stopped.
  releaseLock = async (): Promise<void> => {
    const current = held;
    if (current.kind === "none") {
      return;
    }
    current.stop();
    await current.beating;
    if (await ownsLock()) {
      await removePath(current.dir);
    }
    held = { kind: "none" };
  };

export { acquireLock, assertLock, LOCK_STALE_MS, releaseLock, stopHolding };
