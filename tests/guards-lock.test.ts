// DENKEN engine tests: one engine process per run, and the lock's takeover. Shared setup is in helpers.ts.
import { at, textAt } from "./test-json.ts";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import { fileExists } from "./test-log.ts";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const OK = 0,
  FAILED = 1,
  NONE = 0,
  STALE_AGE_MS = 60_000,
  DEAD_PID = 999_999,
  lockOf = (run: TestRun): string => path.join(run.proj, ".denken", "locks", `${path.basename(run.run)}.lock`),
  // Another process holds the lock: its pid, and a nonce that is not this test's.
  hold = async (run: TestRun, pid: number): Promise<void> => {
    await rm(lockOf(run), { force: true, recursive: true });
    await mkdir(lockOf(run));
    await writeFile(path.join(lockOf(run), "owner"), JSON.stringify({ nonce: "other", pid }));
  },
  heldByLive = async (run: TestRun): Promise<void> => {
    await hold(run, process.pid);
    const busy = await run.denken("next", run.run, "--wait", "1"),
      calls = await run.calls(),
      retry = await run.denken("retry", run.run);
    assert.equal(at(busy.json, "busy"), true);
    assert.equal(calls.length, NONE);
    assert.equal(retry.status, FAILED);
  },
  // A live pid with a heartbeat older than 30s (for example, a reused pid) is stale too.
  staleTime = (): Date => new Date(Date.now() - STALE_AGE_MS),
  heldBySilent = async (run: TestRun): Promise<void> => {
    await utimes(lockOf(run), staleTime(), staleTime());
    const done = await run.drive(),
      left = await fileExists(lockOf(run));
    assert.equal(textAt(done, "action"), "done");
    assert.ok(!left);
  },
  heldByDead = async (run: TestRun): Promise<void> => {
    await hold(run, DEAD_PID);
    const status = await run.denken("status", run.run),
      next = await run.denken("next", run.run);
    assert.equal(status.status, OK);
    assert.equal(textAt(next.json, "action"), "done");
  },
  oneEngine = async (): Promise<void> => {
    const run = await setup();
    await run.denken("start", run.run);
    await heldByLive(run);
    await heldBySilent(run);
    await heldByDead(run);
  };

await test("only one engine process works on a run at a time; a dead or silent holder's lock is taken over", oneEngine);
