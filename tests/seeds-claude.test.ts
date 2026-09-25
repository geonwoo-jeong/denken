// DENKEN engine tests: FLAMME's seeds on Claude, one per kind of call, forked with the seed's own flags. Shared setup is in helpers.ts.
import { at, keysAt, parsed, textAt } from "./test-json.ts";
import { changes, finding } from "./test-scenario.ts";
import { logText, runText, shapeOf, valueAfter } from "./models-support.ts";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const NEXT = 1,
  SEEDS = 4,
  SEED_CALLS: readonly string[] = ["claude plan-flamme-worker rw", "claude dev-flamme-reviewer ro", "claude qa-flamme-qa rw", "claude wiki-flamme-worker rw"],
  HOOKLESS: readonly string[] = ["plan-flamme-worker", "plan-methode-1", "dev-ubel-1", "qa-genau-1"],
  // Claude's seeds: the workers' (made again once there is a confirmed development TODO), the reviewers' and QA's.
  checkSeedCalls = async (project: TestRun): Promise<void> => {
    const calls = await project.calls();
    assert.deepEqual(calls.filter((call) => call.includes("flamme")), SEED_CALLS);
    assert.equal(calls.at(calls.indexOf("claude plan-flamme-worker rw") + NEXT), "claude plan-methode-1 rw");
    assert.ok(!calls.some((call) => call.startsWith("codex") && call.includes("flamme")));
  },
  checkForkShape = (args: readonly string[], seedArgs: readonly string[]): void => {
    assert.ok(args.includes("--fork-session"));
    assert.deepEqual(shapeOf(args), shapeOf(seedArgs));
    assert.ok(!args.includes("--append-system-prompt-file"));
    assert.ok(args.includes("--exclude-dynamic-system-prompt-sections"));
  },
  // Both of METHODE's rounds fork with exactly the seed's flags: the first forks the seed, the second continues its own first session.
  checkForks = async (project: TestRun): Promise<void> => {
    const seedArgs = await project.argsOf("plan-flamme-worker"),
      first = await project.argsOf("plan-methode-1"),
      second = await project.argsOf("plan-methode-2");
    assert.equal(valueAfter(first, "--resume"), valueAfter(seedArgs, "--session-id"));
    assert.equal(valueAfter(second, "--resume"), valueAfter(first, "--session-id"));
    checkForkShape(first, seedArgs);
    checkForkShape(second, seedArgs);
  },
  // A fork's role is in its message, since the forked session keeps the seed's system prompt; METHODE gets the request there.
  checkForkPrompts = async (project: TestRun): Promise<void> => {
    const first = await runText(project, "calls", "plan-methode-1.prompt.md"),
      second = await runText(project, "calls", "plan-methode-2.prompt.md");
    assert.ok(second.startsWith("## This call"));
    assert.ok(first.startsWith("# METHODE:"));
    assert.match(first, /- Read:\n {2}- \S+request\.md/u);
  },
  // A worker seed never holds the request (STARK sees only the development TODO); the reviewer seed does.
  checkSeedPrompts = async (project: TestRun): Promise<void> => {
    const plan = await runText(project, "calls", "plan-methode-1.seed.prompt.md"),
      wiki = await runText(project, "calls", "wiki-serie-1.seed.prompt.md"),
      review = await runText(project, "calls", "dev-ubel-1.seed.prompt.md");
    assert.match(plan, /- Seed for: worker\. Used by the workers who plan, build and document \(METHODE, STARK, SERIE\)\.\n[\s\S]*- Read: nothing from the run yet; the project itself\n/u);
    assert.match(wiki, /- Seed for: worker\.[\s\S]*- Read:\n {2}- \S+todo-dev\.md\n/u);
    assert.doesNotMatch(wiki, /request\.md/u);
    assert.match(review, /- Seed for: reviewer\.[\s\S]*- Read:\n {2}- \S+request\.md\n- This call answers in JSON/u);
  },
  // No hook of anyone's interactive sessions runs in a DENKEN call.
  checkHooks = async (project: TestRun): Promise<void> => {
    const all = await Promise.all(
      HOOKLESS.map(async (key) => {
        const args = await project.argsOf(key);
        return { key, settings: parsed(valueAfter(args, "--settings")) };
      }),
    );
    for (const call of all) {
      assert.equal(at(call.settings, "disableAllHooks"), true, call.key);
    }
  },
  checkSeedRecord = async (project: TestRun): Promise<void> => {
    const seedId = valueAfter(await project.argsOf("plan-flamme-worker"), "--session-id"),
      state = await project.state(),
      status = await project.denken("status", project.run),
      firstRound = await logText(project, "01-planning", "01_methode-round1.md");
    assert.equal(keysAt(state, "seedSessions").length, SEEDS);
    assert.match(
      await logText(project, "timeline.md"),
      /\*\*FLAMME \(claude\)\*\* · seeded the worker context in the plan stage, for plan-methode-1 \(in 100 · cache read 300 · out 10\); calls with the same perspective and settings fork it/u,
    );
    assert.ok(firstRound.includes(`- Seed: forked from FLAMME's seed ${seedId}, made for this call\n`));
    assert.match(await logText(project, "01-planning", "03_methode-round2.md"), /- Session: continued the session of plan-methode-1 \(round 2 in it\)\n/u);
    assert.equal(at(status.json, "tokens", "flamme", "calls"), SEEDS);
  },
  seedsOnClaude = async (): Promise<void> => {
    const project = await setup({ "plan-richter-1": changes(finding("scope", { file: "todo-dev.md" })) }, { seeds: { claude: true } }),
      started = await project.denken("start", project.run),
      done = await project.drive();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    await checkSeedCalls(project);
    await checkForks(project);
    await checkForkPrompts(project);
    await checkSeedPrompts(project);
    await checkHooks(project);
    await checkSeedRecord(project);
  };

await test("FLAMME: a worker seed, a reviewer seed and a QA seed; every call forks its kind's seed with the same flags", seedsOnClaude);
