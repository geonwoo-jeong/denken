// DENKEN engine tests: the levels DENKEN picks per stage, and the checks on them. Shared setup is in helpers.ts.
import type { JsonValue, TestRun } from "./test-types.ts";
import { argsLine, logText } from "./models-support.ts";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const levelOf = (started: JsonValue | symbol, role: string): readonly string[] => [
    textAt(started, "roles", role, "model"),
    textAt(started, "roles", role, "effort"),
    textAt(started, "roles", role, "level"),
  ],
  checkStarted = (started: JsonValue | symbol): void => {
    assert.equal(textAt(started, "action"), "started");
    // Claude light; its checker stays at standard.
    assert.deepEqual(levelOf(started, "methode"), ["sonnet", "low", "light"]);
    assert.deepEqual(levelOf(started, "richter"), ["", "", "standard"]);
    // Codex heavy: effort only. A checker is as heavy as the work it checks, and GENAU checks STARK's work too.
    assert.deepEqual(levelOf(started, "stark"), ["", "high", "heavy"]);
    assert.deepEqual(levelOf(started, "ubel"), ["opus", "high", "heavy"]);
    assert.deepEqual(levelOf(started, "genau"), ["opus", "high", "heavy"]);
    assert.deepEqual(levelOf(started, "serie"), ["sonnet", "low", "light"]);
  },
  checkArgs = async (project: TestRun): Promise<void> => {
    assert.match(await argsLine(project, "plan-methode-1"), /--model sonnet --effort low/u);
    assert.match(await argsLine(project, "dev-stark-1"), /model_reasoning_effort="high"/u);
    assert.match(await argsLine(project, "dev-ubel-1"), /--model opus --effort high/u);
  },
  // The step file and the status show what ran, and how much came from the cache.
  checkRecord = async (project: TestRun): Promise<void> => {
    const step = await logText(project, "01-planning", "01_methode-round1.md"),
      status = await project.denken("status", project.run);
    assert.match(step, /- Level: light\n- Model that ran: sonnet-resolved\n- Tokens: in 100 · out 10 · cache read 300 · cache write 100/u);
    assert.equal(textAt(status.json, "roles", "methode"), "claude: sonnet, low [light]");
    assert.equal(textAt(status.json, "tokens", "methode", "fromCache"), "60%");
  },
  levelsPerStage = async (): Promise<void> => {
    const project = await setup(),
      started = await project.denken("start", project.run, "--level", "plan=light", "--level", "dev=heavy", "--level", "wiki=light"),
      done = await project.drive();
    checkStarted(started.json);
    assert.equal(textAt(done, "action"), "done");
    await checkArgs(project);
    await checkRecord(project);
  },
  levelsChecked = async (): Promise<void> => {
    const project = await setup(),
      qa = await project.denken("start", project.run, "--level", "qa=light"),
      richter = await project.denken("start", project.run, "--level", "richter=light"),
      turbo = await project.denken("start", project.run, "--level", "dev=turbo"),
      model = await project.denken("start", project.run, "--model", "plan=opus"),
      effort = await project.denken("start", project.run, "--effort", "stark=max9"),
      started = await project.denken("start", project.run, "--model", "stark=gpt-mini", "--effort", "genau=medium"),
      state = await project.state();
    assert.match(textAt(qa.json, "error"), /qa checks other work \(genau\), and a checker never runs below standard/u);
    assert.match(textAt(richter.json, "error"), /a checker never runs below standard/u);
    assert.match(textAt(turbo.json, "error"), /a level is one of light, standard, heavy/u);
    assert.match(textAt(model.json, "error"), /--model names one role/u);
    assert.match(textAt(effort.json, "error"), /stark runs on codex, whose effort is one of/u);
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(state, "overrides", "stark", "model"), "gpt-mini");
  };

await test("levels: DENKEN picks a level per stage; workers can go light, checkers never below standard or their worker", levelsPerStage);
await test("levels: a checker can't be made light, and levels are checked before the run starts", levelsChecked);
