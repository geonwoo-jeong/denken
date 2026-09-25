// DENKEN engine tests: the tick command runs its argv as given, without a shell. Shared setup is in helpers.ts.
import type { JsonObject, JsonValue, TestRun } from "./test-types.ts";
import { listAt, parsed, textAt } from "./test-json.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const QUOTED_ARGS: readonly string[] = ["node", "-e", "console.log(process.argv[1]); process.exit(process.argv[1] === 'login flow' ? 0 : 1)", "login flow"],
  started = async (scenario: JsonObject): Promise<TestRun> => {
    const run = await setup(scenario),
      start = await run.denken("start", run.run);
    assert.equal(textAt(start.json, "action"), "started");
    return run;
  },
  callFile = async (run: TestRun, name: string): Promise<string> => {
    const text = await readOr(path.join(run.proj, run.run, "calls", name), "");
    return text;
  },
  ledgerOf = async (run: TestRun): Promise<readonly (JsonValue | symbol)[]> => {
    const text = await callFile(run, "dev-stark-1.ticks.jsonl");
    return text
      .trim()
      .split("\n")
      .map((line) => parsed(line));
  },
  // An argument with a space reaches the command whole, and the record quotes it the way a shell would read it.
  quotedArgument = async (): Promise<void> => {
    const run = await started({ "dev-stark-1": { tickArgs: QUOTED_ARGS } }),
      done = await run.drive(),
      ledger = await ledgerOf(run),
      [first] = ledger;
    assert.equal(textAt(done, "action"), "done");
    assert.deepEqual(
      ledger.map((entry) => [textAt(entry, "item"), textAt(entry, "lastLine")]),
      [
        ["DEV-001", "login flow"],
        ["DEV-002", "login flow"],
      ],
    );
    assert.match(textAt(first ?? "", "command"), /'login flow'$/u);
  },
  // "|| true" is just more arguments to false, so the failure stands and nothing is ticked.
  noShell = async (): Promise<void> => {
    const run = await started({ "dev-stark-1": { tickArgs: ["false", "||", "true"] } }),
      end = await run.drive(),
      gaps = parsed(await callFile(run, "dev-stark-1.gaps.json"));
    assert.notEqual(textAt(end, "action"), "");
    assert.deepEqual(
      listAt(gaps, "findings").map((gap) => textAt(gap, "identity")),
      ["DEV-001", "DEV-002"],
    );
  },
  argvWithoutShell = async (): Promise<void> => {
    await quotedArgument();
    await noShell();
  };

await test("the tick command runs its argv without a shell", argvWithoutShell);
