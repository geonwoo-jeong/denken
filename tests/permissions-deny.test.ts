// DENKEN engine tests: a denied permission, refused grants, and a directory grant that reaches the CLI. Shared setup is in helpers.ts.
import type { JsonObject, TestRun } from "./test-types.ts";
import { at, parsed, textAt } from "./test-json.ts";
import { mkdtemp, realpath } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { tmpdir } from "node:os";

const THIRD_ATTEMPT = 3,
  FLAG_AND_VALUE = 2,
  // STARK asks for a directory outside the project, is denied, then asks for a cache directory.
  scenarioFor = (cache: string): JsonObject => ({
    "dev-stark-1": [{ requestPermission: { need: "dir:/opt/shared", why: "write a cache" } }, { requestPermission: { need: `dir:${cache}`, why: "npm cache" } }, {}],
  }),
  runFile = async (run: TestRun, name: string): Promise<string> => {
    const text = await readOr(path.join(run.proj, run.run, name), "");
    return text;
  },
  denyThenAskAgain = async (run: TestRun): Promise<void> => {
    const first = await run.drive(),
      denied = await run.denken("deny", run.run, "--note", "No writes outside the project; keep the cache inside it."),
      second = await run.drive();
    assert.equal(textAt(first, "action"), "needs_permission");
    assert.equal(textAt(denied.json, "action"), "denied");
    assert.equal(textAt(second, "action"), "needs_permission");
  },
  // Grants DENKEN may not give: a Codex tool pattern, a missing directory, one outside the project without the user's words, and /.
  checkRefusedGrants = async (run: TestRun, cache: string): Promise<void> => {
    const tool = await run.denken("grant", run.run, "--tool", "Bash(npm *)", "--note", "x"),
      missing = await run.denken("grant", run.run, "--dir", path.join(tmpdir(), "no-such-dir-denken"), "--note", "x"),
      outside = await run.denken("grant", run.run, "--dir", cache, "--note", "x"),
      root = await run.denken("grant", run.run, "--dir", "/", "--user-said", "ok", "--note", "x");
    assert.match(textAt(tool.json, "error"), /Claude only/u);
    assert.match(textAt(missing.json, "error"), /does not exist/u);
    assert.match(textAt(outside.json, "error"), /outside the project/u);
    assert.match(textAt(root.json, "error"), /root or home/u);
  },
  checkDirGrant = async (run: TestRun, cache: string): Promise<void> => {
    const real = await realpath(cache),
      job = parsed(await runFile(run, path.join("calls", "dev-stark-1.job.json"))),
      args = await run.argsOf("dev-stark-1", THIRD_ATTEMPT),
      added = args.indexOf("--add-dir"),
      rulings = await runFile(run, "rulings.md");
    assert.equal(at(job, "agent", "granted"), true);
    assert.deepEqual(at(job, "agent", "grants"), { dirs: [real], domains: [], network: false, tools: [] });
    assert.deepEqual(args.slice(added, added + FLAG_AND_VALUE), ["--add-dir", real]);
    assert.equal(at(job, "attempt"), THIRD_ATTEMPT);
    assert.match(rulings, /## P1 · permission · STARK · denied dir:\/opt\/shared\n\nNo writes outside the project/u);
    assert.match(rulings, /## P2 · permission · STARK · granted dir [^\n]*denken-cache-/u);
  },
  grantAndFinish = async (run: TestRun, cache: string): Promise<void> => {
    const granted = await run.denken("grant", run.run, "--dir", cache, "--user-said", "Fine, that cache directory only.", "--note", "A throwaway cache directory."),
      done = await run.drive();
    assert.equal(textAt(granted.json, "action"), "granted");
    assert.equal(textAt(done, "action"), "done");
  },
  denyThenGrantDir = async (): Promise<void> => {
    const cache = await mkdtemp(path.join(tmpdir(), "denken-cache-")),
      run = await setup(scenarioFor(cache)),
      start = await run.denken("start", run.run);
    assert.equal(textAt(start.json, "action"), "started");
    await denyThenAskAgain(run);
    await checkRefusedGrants(run, cache);
    await grantAndFinish(run, cache);
    await checkDirGrant(run, cache);
  };

await test("a denied permission re-runs the call with the reason; a directory grant reaches the CLI", denyThenGrantDir);
