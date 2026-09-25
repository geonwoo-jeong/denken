/*
 * Waiting on a running call through its own files only: its result (meta.json), its pid and its
 * heartbeat. state.json is not re-read until the call has finished, because a misbehaving call may
 * have it in a broken state until it is restored.
 */
import { exists, modifiedAt, movePath, readTextOr } from "./files.ts";
import { failedMeta, readMetaFile } from "./meta.ts";
import { pidAlive, sleep } from "./processes.ts";
import type { ActiveCall } from "./types-items.ts";
import type { CallWait } from "./types-flow.ts";
import type { MetaRead } from "./types-partb.ts";
import { NONE } from "./lists.ts";
import { stopCallGroup } from "./agent-group.ts";

const HEARTBEAT_FRESH_MS = 60_000,
  STARTUP_MS = 30_000,
  POLL_MIN_MS = 200,
  POLL_MAX_MS = 3000,
  POLL_SHARE = 10,
  ageOf = (call: ActiveCall): number => Date.now() - Date.parse(call.started),
  /*
   * A call is alive while its process is, and its heartbeat is fresh (or, before the first beat, it
   * is young). A call without a pid file (its launcher was stopped right after starting it) is judged
   * by its heartbeat alone, so it is not taken for dead and run twice.
   */
  callAlive = async (base: string, call: ActiveCall): Promise<boolean> => {
    const pid = Number(await readTextOr(`${base}.pid`, "0"));
    if (pid > NONE && !pidAlive(pid)) {
      return false;
    }
    if (await exists(`${base}.heartbeat`)) {
      return Date.now() - (await modifiedAt(`${base}.heartbeat`)) < HEARTBEAT_FRESH_MS;
    }
    return ageOf(call) < STARTUP_MS;
  },
  /*
   * Only this attempt's result counts. A result from an earlier attempt of the same call (one judged
   * dead that finished anyway) is set aside, not ingested.
   */
  readCallMeta = async (base: string, call: ActiveCall): Promise<MetaRead> => {
    const read = await readMetaFile(`${base}.meta.json`);
    if (!read.found || !call.nonce || read.meta.nonce === call.nonce) {
      return read;
    }
    await movePath(`${base}.meta.json`, `${base}.stale-${Date.now()}.meta.json`);
    return { found: false, meta: read.meta };
  },
  // Poll quickly at first, then back off to every 3 seconds for long calls.
  pollDelay = (call: ActiveCall, deadline: number): number => Math.min(Math.max(POLL_MIN_MS, ageOf(call) / POLL_SHARE), POLL_MAX_MS, Math.max(NONE, deadline - Date.now())),
  waitForMeta = async (base: string, call: ActiveCall, deadline: number): Promise<MetaRead> => {
    const read = await readCallMeta(base, call);
    if (read.found || Date.now() >= deadline || !(await callAlive(base, call))) {
      return read;
    }
    await sleep(pollDelay(call, deadline));
    return waitForMeta(base, call, deadline);
  },
  // The call's result; or, when its process died without one, a failure, after stopping whatever its agent CLI left running.
  waitForCall = async (base: string, call: ActiveCall, deadline: number): Promise<CallWait> => {
    const read = await waitForMeta(base, call, deadline);
    if (read.found) {
      return { meta: read.meta, running: false };
    }
    if (await callAlive(base, call)) {
      return { meta: read.meta, running: true };
    }
    await stopCallGroup(base, call.provider);
    return { meta: failedMeta("", "the call process exited without writing a result"), running: false };
  };

export { waitForCall };
