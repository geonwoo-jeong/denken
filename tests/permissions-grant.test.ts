// DENKEN engine tests: a worker asks DENKEN for a permission, and a grant re-runs the call with it. Shared setup is in helpers.ts.
import type { JsonObject, JsonValue, TestRun } from "./test-types.ts";
import { at, listAt, parsed, textAt } from "./test-json.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const FAILED = 1,
  SCENARIO: JsonObject = { "plan-methode-1": [{ requestPermission: { need: "network", why: "read the upstream API docs" } }, {}] },
  // A role without grants: nothing granted, and every list empty.
  NO_GRANTS: JsonObject = { dirs: [], domains: [], network: false, tools: [] },
  runFile = async (run: TestRun, name: string): Promise<string> => {
    const text = await readOr(path.join(run.proj, run.run, name), "");
    return text;
  },
  checkAsk = (ask: JsonValue | symbol): void => {
    assert.equal(textAt(ask, "action"), "needs_permission");
    assert.equal(textAt(ask, "role"), "methode");
    assert.deepEqual(
      listAt(ask, "requests").map((request) => textAt(request, "need")),
      ["network"],
    );
  },
  // A permission stop is not retried, and a grant needs a note and, for the whole network, the user's words.
  checkRefusals = async (run: TestRun): Promise<void> => {
    const retry = await run.denken("retry", run.run),
      noNote = await run.denken("grant", run.run, "--network"),
      noUser = await run.denken("grant", run.run, "--network", "--note", "x");
    assert.equal(retry.status, FAILED);
    assert.equal(noNote.status, FAILED);
    assert.match(textAt(noUser.json, "error"), /--user-said/u);
  },
  checkGranted = async (run: TestRun): Promise<void> => {
    const granted = await run.denken("grant", run.run, "--network", "--user-said", "Yes, it may use the network.", "--note", "Docs are public; read-only access is fine."),
      done = await run.drive(),
      calls = await run.callsFull(),
      rulings = await runFile(run, "rulings.md"),
      job = parsed(await runFile(run, path.join("calls", "plan-richter-1.job.json")));
    assert.equal(textAt(granted.json, "action"), "granted");
    assert.equal(textAt(done, "action"), "done");
    assert.deepEqual(
      calls.filter((call) => call.includes("plan-methode-1")),
      ["claude plan-methode-1 rw nonet", "claude plan-methode-1 rw net"],
    );
    assert.match(rulings, /## P1 · permission · METHODE · granted network/u);
    // The grant belongs to the role that asked; reviewers never get one.
    assert.equal(at(job, "agent", "granted"), false);
    assert.deepEqual(at(job, "agent", "grants"), NO_GRANTS);
  },
  grantReruns = async (): Promise<void> => {
    const run = await setup(SCENARIO),
      start = await run.denken("start", run.run),
      ask = await run.drive();
    assert.equal(textAt(start.json, "action"), "started");
    checkAsk(ask);
    await checkRefusals(run);
    await checkGranted(run);
  };

await test("a worker that lacks a permission asks DENKEN; a grant re-runs the call with it", grantReruns);
