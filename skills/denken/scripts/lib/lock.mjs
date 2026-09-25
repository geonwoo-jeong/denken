// One engine process per run: a directory lock kept alive by a heartbeat.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DENKEN_DIR, fail, now, pidAlive, sleep } from "./core.mjs";

// One engine process per run. Claude Code moves a slow command to the background instead of
// killing it, so without a lock two `next` processes could ingest or launch the same call.
// The lock is a directory (mkdir is atomic), refreshed by a heartbeat. A lock whose heartbeat
// is older than LOCK_STALE_MS is stale no matter what its pid is, so a reused pid cannot keep
// a dead run busy. A stale lock is taken over by renaming it away, which only one process can do.
export const LOCK_STALE_MS = 30000;

export const lock = { dir: null, nonce: null };

export function holdsLock() {
  try {
    return JSON.parse(readFileSync(join(lock.dir, "owner"), "utf8")).nonce === lock.nonce;
  } catch {
    return false;
  }
}

export function assertLock() {
  if (!holdsLock()) fail("this engine process lost the run lock (another process took the run over); stopping without changing anything");
}

export async function acquireLock(runDir, waitMs) {
  mkdirSync(join(DENKEN_DIR, "locks"), { recursive: true });
  const dir = join(DENKEN_DIR, "locks", `${basename(runDir)}.lock`);
  const deadline = Date.now() + waitMs;
  const nonce = randomUUID();
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid, nonce, since: now() }));
      Object.assign(lock, { dir, nonce });
      setInterval(() => {
        try {
          const t = new Date();
          utimesSync(dir, t, t);
        } catch {}
      }, 5000).unref();
      const release = () => holdsLock() && rmSync(dir, { recursive: true, force: true });
      process.on("exit", release);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => {
          release();
          process.exit(128);
        });
      }
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let stale;
    try {
      const age = Date.now() - statSync(dir).mtimeMs;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(join(dir, "owner"), "utf8"));
      } catch {}
      // No owner file yet means another process is between mkdir and writing it.
      stale = age > LOCK_STALE_MS || (owner ? !pidAlive(owner.pid) : age > 2000);
    } catch {
      continue;
    }
    if (stale) {
      const grave = `${dir}.stale-${randomUUID()}`;
      try {
        renameSync(dir, grave);
        rmSync(grave, { recursive: true, force: true });
      } catch {}
      continue;
    }
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}
