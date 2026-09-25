// DENKEN engine tests: a checker is kept apart from the work it checks, by model and by what ran. Shared setup is in helpers.ts.
import type { JsonObject, TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import { logText } from "./models-support.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

// One provider, with UBEL on the given model: "opus" and "claude-opus-5-5" name the same model.
const oneProvider = (ubelModel: string): JsonObject => ({
    providers: ["claude"],
    roles: {
      frieren: { effort: "high" },
      genau: { model: "haiku" },
      richter: { effort: "high" },
      stark: { model: "opus" },
      ubel: { model: ubelModel },
    },
  }),
  // Asked for different models, but both ran as the same one (an alias, an allowlist): the check is not used.
  checkSameModelRan = async (project: TestRun): Promise<void> => {
    const started = await project.denken("start", project.run),
      stopped = await project.drive(),
      timeline = await logText(project, "timeline.md");
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(stopped, "reason"), "same_model_ran");
    assert.equal(textAt(stopped, "checked"), "dev-stark-1");
    assert.match(timeline, /UBEL ran as claude-opus-5-5, the same model and effort as the work it checks \(dev-stark-1\); its result is not used/u);
    assert.match(textAt(stopped, "next"), /levels <run> ubel=<level>/u);
  },
  // Retrying the same assignment would only block again, so it waits for a change.
  checkRetry = async (project: TestRun): Promise<void> => {
    const refused = await project.denken("retry", project.run),
      changed = await project.denken("levels", project.run, "ubel=heavy", "--note", "Check with a stronger effort than the work."),
      resumed = await project.denken("retry", project.run),
      done = await project.drive();
    assert.match(textAt(refused.json, "error"), /ubel would run the same way again/u);
    assert.equal(textAt(changed.json, "action"), "levels");
    assert.equal(textAt(resumed.json, "action"), "resumed");
    assert.equal(textAt(done, "action"), "done");
  },
  separation = async (): Promise<void> => {
    const same = await setup({}, oneProvider("claude-opus-5-5")),
      refused = await same.denken("start", same.run),
      ran = await setup({ "dev-stark-1": { modelRan: "claude-opus-5-5" }, "dev-ubel-1": { modelRan: "claude-opus-5-5" } }, oneProvider("sonnet"));
    assert.equal(textAt(refused.json, "reason"), "same_reviewer");
    await checkSameModelRan(ran);
    await checkRetry(ran);
  };

await test("levels: the separation holds by model, not by name, and by what actually ran", separation);
