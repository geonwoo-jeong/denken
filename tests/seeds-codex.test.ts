// DENKEN engine tests: FLAMME on Codex, and what happens when a seed or its fork goes wrong. Shared setup is in helpers.ts.
import { argsLine, logText, recordAt, runText, textsAt } from "./models-support.ts";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const START = 0,
  HEAD = 3,
  SECOND_ATTEMPT = 2,
  headOf = async (project: TestRun, key: string): Promise<readonly string[]> => {
    const args = await project.argsOf(key);
    return args.slice(START, HEAD);
  },
  // Forks always set their own sandbox: a fork given none would keep its seed's.
  checkCodexForks = async (project: TestRun): Promise<void> => {
    const stark = await project.argsOf("dev-stark-1"),
      richter = await project.argsOf("plan-richter-1");
    assert.deepEqual(stark.slice(START, HEAD), ["exec", "fork", "thread-dev-flamme-worker"]);
    assert.ok(stark.includes('sandbox_mode="workspace-write"') && !stark.includes("-s"));
    assert.deepEqual(richter.slice(START, HEAD), ["exec", "fork", "thread-plan-flamme-reviewer"]);
    assert.ok(richter.includes('sandbox_mode="read-only"'));
    // FRIEREN, a reviewer with the same settings, forks the same reviewer seed.
    assert.deepEqual(await headOf(project, "wiki-frieren-1"), ["exec", "fork", "thread-plan-flamme-reviewer"]);
  },
  // The seed itself only reads, and a worker's seed never holds the request.
  checkCodexSeed = async (project: TestRun): Promise<void> => {
    const starkSeed = await runText(project, "calls", "dev-stark-1.seed.prompt.md"),
      seedArgs = await argsLine(project, "dev-flamme-worker");
    assert.ok(seedArgs.includes("-s read-only"));
    assert.match(starkSeed, /- Read:\n {2}- \S+todo-dev\.md\n/u);
    assert.doesNotMatch(starkSeed, /request\.md/u);
  },
  seedsOnCodex = async (): Promise<void> => {
    const project = await setup({}, { seeds: { claude: false, codex: true } }),
      started = await project.denken("start", project.run),
      done = await project.drive();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    await checkCodexForks(project);
    await checkCodexSeed(project);
  },
  // A fork that cannot start (its seed gone, say) runs from scratch, and the seed is dropped.
  forkFallback = async (): Promise<void> => {
    const project = await setup({ "dev-ubel-1": [{ fail: "No conversation found with session ID" }, {}] }, { seeds: { claude: true } }),
      started = await project.denken("start", project.run),
      done = await project.drive(),
      seeds = recordAt(await project.state(), "seedSessions"),
      retried = await project.argsOf("dev-ubel-1", SECOND_ATTEMPT);
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.match(await logText(project, "timeline.md"), /\*\*ENGINE\*\* · UBEL ran without FLAMME's seed: the fork of \S+ failed/u);
    assert.ok(!Object.values(seeds).some((seed) => textAt(seed, "perspective") === "reviewer"));
    assert.ok(!retried.includes("--resume"));
  },
  // FLAMME's seed only reads: a seed that changed anything is a violation, and the call does not run.
  seedViolation = async (): Promise<void> => {
    const project = await setup({ "plan-flamme-worker": { touch: "a.txt" } }, { seeds: { claude: true } }),
      started = await project.denken("start", project.run),
      stopped = await project.drive();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(stopped, "reason"), "guard_violation");
    assert.match(textsAt(stopped, "violations").join("\n"), /FLAMME's seed: project files changed/u);
  },
  seedsOff = async (): Promise<void> => {
    const project = await setup({}, { seeds: { claude: true } }),
      started = await project.denken("start", project.run, "--seeds", "off"),
      done = await project.drive(),
      calls = await project.calls();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.ok(!calls.some((call) => call.includes("flamme")));
  },
  seedsGoneWrong = async (): Promise<void> => {
    await forkFallback();
    await seedViolation();
    await seedsOff();
  };

await test("FLAMME on Codex: forks always set their own sandbox, and a worker's seed never holds the request", seedsOnCodex);
await test("FLAMME: a fork that cannot start runs from scratch; a seed that changes files is a violation; --seeds off turns seeding off", seedsGoneWrong);
