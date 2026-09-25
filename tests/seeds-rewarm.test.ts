// DENKEN engine tests: a checker's seed answers with a placeholder, and an idle seed is re-warmed. Shared setup is in helpers.ts.
import type { JsonObject, TestRun } from "./test-types.ts";
import { at, parsed, textAt } from "./test-json.ts";
import { editState, hoursAgo, logText, recordAt, reviewerSeed, runText, setInEach, valueAfter } from "./models-support.ts";
import assert from "node:assert/strict";
import { qaItem } from "./test-scenario.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const QA_TWO = 2,
  BEFORE_CALL = 1,
  IDLE_HOURS = 2,
  // The seed's answer uses the schema's placeholder, and the fork is told it is not a result.
  checkPlaceholder = async (project: TestRun): Promise<void> => {
    const seedOut = parsed(await runText(project, "calls", "dev-ubel-1.seed.out.md")),
      prompt = await runText(project, "calls", "dev-ubel-1.prompt.md");
    assert.equal(at(seedOut, "verdict"), "CONTEXT_LOADED");
    assert.match(prompt, /FLAMME's JSON at the end of it \(CONTEXT_LOADED\) only marked the context as loaded; it is not a result/u);
  },
  // An hour passes while DENKEN decides: every seed was last used two hours ago.
  staleSeeds = (state: JsonObject): JsonObject =>
    Object.assign(structuredClone(state), { seedSessions: setInEach(recordAt(state, "seedSessions"), { key: "lastUsedAt", value: hoursAgo(IDLE_HOURS) }) }),
  checkRewarmed = async (project: TestRun, before: string): Promise<void> => {
    const calls = await project.calls(),
      after = reviewerSeed(await project.state()),
      ubel = await project.argsOf("dev-ubel-2"),
      job = parsed(await runText(project, "calls", "dev-ubel-2.job.json"));
    assert.equal(calls.at(calls.indexOf("claude dev-ubel-2 ro") - BEFORE_CALL), "claude rewarm");
    assert.notEqual(after, before);
    assert.equal(valueAfter(ubel, "--resume"), after);
    assert.match(await logText(project, "timeline.md"), /FLAMME \(claude\)\*\* · re-warmed the reviewer seed, idle for close to an hour, before dev-ubel-2 forked it/u);
    // Seeded Claude calls keep their cache for an hour.
    assert.equal(at(job, "seed", "rewarm"), true);
  },
  rewarm = async (): Promise<void> => {
    const project = await setup(
        {
          "dev-stark-2": [{ requestPermission: { need: "network", why: "fetch a fixture" } }, {}],
          "qa-genau-1": { qa: { items: [qaItem(BEFORE_CALL), qaItem(QA_TWO, "FAIL")], result: "FAIL", summary: "two fails" } },
        },
        { seeds: { claude: true } },
      ),
      started = await project.denken("start", project.run),
      stopped = await project.drive(),
      before = reviewerSeed(await project.state());
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(stopped, "reason"), "needs_permission");
    await checkPlaceholder(project);
    await editState(project, staleSeeds);
    await project.denken("grant", project.run, "--network", "--user-said", "Fine.", "--note", "Fixture download.");
    assert.equal(textAt(await project.drive(), "action"), "done");
    await checkRewarmed(project, before);
  };

await test("FLAMME: a checker's seed ends with a placeholder, not a verdict; a seed idle for an hour is re-warmed before a fork", rewarm);
