// DENKEN engine tests: the run's record in ai-log: its numbering, its call facts, and secrets kept out. Shared setup is in helpers.ts.
import type { JsonValue, TestRun } from "./test-types.ts";
import { at, listAt, textAt } from "./test-json.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const SECRET_LINE = 2,
  started = async (run: TestRun): Promise<JsonValue | symbol> => {
    await run.denken("start", run.run);
    const end = await run.drive();
    return end;
  },
  numbered = async (): Promise<void> => {
    const run = await setup(),
      second = await run.denken("new", "슬러그 테스트");
    assert.match(textAt(second.json, "log"), /^ai-log\/\d{8}\/002_\d{6}_슬러그-테스트$/u);
  },
  callFacts = async (): Promise<void> => {
    const run = await setup(),
      end = await started(run),
      log = path.join(run.proj, textAt(await run.state(), "log")),
      step = await readFile(path.join(log, "02-development", "01_stark-round1.md"), "utf8"),
      timeline = await readFile(path.join(log, "timeline.md"), "utf8");
    assert.equal(textAt(end, "action"), "done");
    assert.match(step, /## Call facts\n\n- Provider: codex\n- CLI: codex 0\.0\.0-fake\n- Session: thread-dev-stark-1\n- Exit: 0\n- Duration: \d+s/u);
    assert.match(timeline, /STARK\*\* · finished dev round 1 \(\d+s\)/u);
  },
  // A likely secret found in the record: an AWS key on line 2 of QA-001's evidence file.
  foundKey = (hit: JsonValue): boolean =>
    textAt(hit, "kind") === "AWS access key" && textAt(hit, "file").endsWith("03-qa/qa-1/evidence/QA-001.txt") && at(hit, "line") === SECRET_LINE,
  secretsStop = async (run: TestRun, fakeKey: string): Promise<void> => {
    const stop = await started(run),
      ignore = await readFile(path.join(run.proj, "ai-log", ".gitignore"), "utf8");
    assert.equal(textAt(stop, "reason"), "secrets_in_record");
    assert.equal(ignore, "*/*/raw/\n*/*/03-qa/*/evidence/\n");
    assert.ok(listAt(stop, "findings").some((hit) => foundKey(hit)));
    assert.ok(!JSON.stringify(stop).includes(fakeKey));
  },
  secretsAccepted = async (run: TestRun): Promise<void> => {
    const rescan = await run.denken("secrets", run.run, "--rescan"),
      unsaid = await run.denken("secrets", run.run, "--accept"),
      done = await run.denken("secrets", run.run, "--accept", "--user-said", "That key is a documented example value."),
      log = textAt(await run.state(), "log"),
      timeline = await readFile(path.join(run.proj, log, "timeline.md"), "utf8");
    assert.equal(textAt(rescan.json, "reason"), "secrets_in_record");
    assert.match(textAt(unsaid.json, "error"), /--user-said/u);
    assert.equal(textAt(done.json, "action"), "done");
    assert.match(timeline, /ENGINE\*\* · secret scan: \d+ possible secret\(s\)/u);
  },
  /*
   * A leaked environment dump in QA evidence, as a careless check might capture. The fake key is
   * assembled at runtime so the test source itself never looks like a leaked credential.
   */
  secretsKept = async (): Promise<void> => {
    const fakeKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join(""),
      run = await setup({ "qa-genau-1": { evidenceText: `AWS_ACCESS_KEY_ID=${fakeKey}\n` } });
    await secretsStop(run, fakeKey);
    await secretsAccepted(run);
  };

await test("ai-log runs are numbered per day and keep non-ASCII names", numbered);
await test("step files and the timeline carry each call's facts", callFacts);
await test("the record keeps raw exchanges and evidence out of git, and reports likely secrets before DONE", secretsKept);
