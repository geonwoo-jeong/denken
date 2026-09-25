// DENKEN engine tests: each role reads only its inputs, and nobody but METHODE writes the plan. Shared setup is in helpers.ts.
import { readsOf, runText, startedRun, textsAt } from "./plan-ticks-support.ts";
import { realpath, writeFile } from "node:fs/promises";
import type { TestRun } from "./test-types.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const FAILURE = 1,
  NEXT = 1,
  UNCLEAR_REQUEST =
    "## Goal\nX.\n\n## Confirmed\n- REQ-001. One. Done when: it works.\n- REQ-002. Two.\n\n## Out of scope\n- None\n\n## Not now\n- None\n\n## Cautions\n- None\n\n[NEEDS CLARIFICATION: which encoding?]\n",
  REVIEWERS: readonly (readonly [string, string])[] = [
    ["plan-richter-1", "RICHTER"],
    ["dev-ubel-1", "UBEL"],
    ["wiki-frieren-1", "FRIEREN"],
  ],
  checkReads = async (run: TestRun): Promise<void> => {
    const frieren = await readsOf(run, "wiki-frieren-1");
    assert.deepEqual(await readsOf(run, "plan-methode-1"), ["request.md"]);
    assert.deepEqual(await readsOf(run, "plan-richter-1"), ["request.md", "todo-dev.md", "todo-qa.md"]);
    assert.deepEqual(await readsOf(run, "dev-stark-1"), ["todo-dev.md"]);
    assert.deepEqual(await readsOf(run, "dev-ubel-1"), ["request.md", "todo-dev.md", "dev-report.md", "dev-ubel-1.diff"]);
    assert.deepEqual(await readsOf(run, "qa-genau-1"), ["request.md", "todo-qa.md"]);
    assert.ok(frieren.includes("request.md"));
  },
  /*
   * Each stage has its own reviewer, whose instructions add the rules every reviewer shares. The
   * instructions are the call's system part, the same for every call of the role, so a provider
   * can cache them; the call's own facts are the message.
   */
  checkReviewer = async (run: TestRun, reviewer: readonly [string, string]): Promise<void> => {
    const [call, name] = reviewer,
      system = await runText(run, "calls", `${call}.system.md`),
      prompt = await runText(run, "calls", `${call}.prompt.md`);
    assert.ok(system.startsWith(`# ${name}:`));
    assert.match(system, /## How every DENKEN reviewer works/u);
    assert.ok(prompt.startsWith("## This call"));
  },
  checkClaudeArgs = async (run: TestRun): Promise<void> => {
    const args = await run.argsOf("dev-ubel-1"),
      proj = await realpath(run.proj);
    assert.equal(args[args.indexOf("--append-system-prompt-file") + NEXT], path.join(proj, run.run, "calls", "dev-ubel-1.system.md"));
    // Per-machine sections move out of the system prompt only in units' worktrees, where it helps.
    assert.ok(!args.includes("--exclude-dynamic-system-prompt-sections"));
  },
  eachRoleReadsItsInputs = async (): Promise<void> => {
    const run = await startedRun();
    await run.drive();
    await checkReads(run);
    await Promise.all(
      REVIEWERS.map(async (reviewer) => {
        await checkReviewer(run, reviewer);
      }),
    );
    await checkClaudeArgs(run);
  },
  starkLeavesThePlan = async (): Promise<void> => {
    const run = await startedRun({ "dev-stark-1": { touch: "$RUN/todo-dev.md" } }),
      stop = await run.drive(),
      todo = await runText(run, "todo-dev.md");
    assert.equal(textAt(stop, "reason"), "guard_violation");
    assert.match(textsAt(stop, "violations").join("\n"), /todo-dev\.md \(restored\)/u);
    assert.doesNotMatch(todo, /tampered/u);
  },
  refusedStart = async (run: TestRun): Promise<void> => {
    const refused = await run.denken("start", run.run);
    assert.equal(refused.status, FAILURE);
    assert.match(textAt(refused.json, "error"), /REQ-002 needs a "Done when:"/u);
    assert.match(textAt(refused.json, "error"), /which encoding\?/u);
  },
  unclearRequest = async (): Promise<void> => {
    const run = await setup();
    await writeFile(path.join(run.proj, run.run, "request.md"), UNCLEAR_REQUEST);
    await refusedStart(run);
  };

await test("each role reads only its inputs: STARK the dev TODO, GENAU the request and QA TODO, reviewers the request", eachRoleReadsItsInputs);
await test("STARK may not edit the TODO lists or the request", starkLeavesThePlan);
await test("start refuses open clarification markers and REQ items without Done when", unclearRequest);
