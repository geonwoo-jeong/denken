// DENKEN engine tests: permission decisions: a need denied again, a role that keeps asking, and narrow grants. Shared setup is in helpers.ts.
import type { JsonValue, TestRun } from "./test-types.ts";
import { at, parsed, textAt } from "./test-json.ts";
import { readFile, symlink } from "node:fs/promises";
import assert from "node:assert/strict";
import { envText } from "./test-env.ts";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const SECOND_ATTEMPT = 2,
  VALUE_OFFSET = 1,
  started = async (run: TestRun): Promise<JsonValue | symbol> => {
    await run.denken("start", run.run);
    const end = await run.drive();
    return end;
  },
  errorOf = async (run: TestRun, ...args: readonly string[]): Promise<string> => {
    const decided = await run.denken(...args);
    return textAt(decided.json, "error");
  },
  userRequired = async (run: TestRun): Promise<void> => {
    const unsaid = await errorOf(run, "deny", run.run, "--note", "x"),
      ruled = await run.denken("rule", run.run, "--decision", "abort", "--note", "Stopping: the task needs a network the user will not open.");
    assert.match(unsaid, /--user-said/u);
    assert.equal(textAt(ruled.json, "action"), "ruled");
  },
  // Attempt 2 asks for the same thing: denied again by the engine, and attempt 3 runs at once.
  deniedAgain = async (): Promise<void> => {
    const ask = { requestPermission: { need: "network", why: "download" } },
      run = await setup({ "dev-stark-1": [ask, ask, ask] }),
      asked = await started(run),
      denied = await run.denken("deny", run.run, "--note", "Vendor the fixture instead."),
      loop = await run.drive(),
      rulings = await readFile(path.join(run.proj, run.run, "rulings.md"), "utf8");
    assert.equal(textAt(asked, "action"), "needs_permission");
    assert.equal(textAt(denied.json, "action"), "denied");
    assert.equal(textAt(loop, "reason"), "permission_loop");
    assert.equal(at(loop, "userRequired"), true);
    assert.match(rulings, /## P2 · permission · STARK · denied again \(engine\)/u);
    await userRequired(run);
  },
  refusedTools = async (run: TestRun): Promise<void> => {
    assert.match(await errorOf(run, "grant", run.run, "--tool", "Bash(*)", "--note", "x"), /refusing tool pattern/u);
    assert.match(await errorOf(run, "grant", run.run, "--tool", "Bash(node *)", "--note", "x"), /can run anything/u);
    assert.match(await errorOf(run, "grant", run.run, "--tool", "Bash(/bin/bash -c x)", "--note", "x"), /can run anything/u);
    assert.match(await errorOf(run, "grant", run.run, "--tool", "Bash(npm install *)", "--note", "x"), /has a wildcard/u);
    assert.match(await errorOf(run, "grant", run.run, "--tool", "Bash(npm run * --silent)", "--note", "x"), /has a wildcard/u);
    assert.match(await errorOf(run, "grant", run.run, "--tool", "Bash(Python3.12 x)", "--note", "x"), /can run anything/u);
    assert.match(await errorOf(run, "grant", run.run, "--tool", "Bash(git log *)", "--user-said", "ok", "--note", "x"), /git with a wildcard/u);
    assert.match(await errorOf(run, "grant", run.run, "--domain", "*.example.com", "--note", "x"), /--domain with a wildcard/u);
  },
  // A symlink inside the project that points at the home directory is still the home directory.
  refusedHome = async (run: TestRun): Promise<void> => {
    await symlink(envText("HOME"), path.join(run.proj, "home-link"));
    assert.match(await errorOf(run, "grant", run.run, "--dir", "home-link", "--user-said", "ok", "--note", "x"), /root or home/u);
  },
  settingsOf = (args: readonly string[]): JsonValue | symbol => parsed(args[args.indexOf("--settings") + VALUE_OFFSET] ?? ""),
  domainGranted = async (run: TestRun): Promise<void> => {
    const granted = await run.denken("grant", run.run, "--domain", "registry.npmjs.org", "--note", "Public registry, read-only."),
      codexAsks = await run.drive(),
      codexDomain = await errorOf(run, "grant", run.run, "--domain", "example.com", "--note", "x"),
      denied = await run.denken("deny", run.run, "--note", "Not needed for this item."),
      done = await run.drive(),
      args = await run.argsOf("plan-methode-1", SECOND_ATTEMPT);
    assert.equal(textAt(granted.json, "action"), "granted");
    assert.equal(textAt(codexAsks, "action"), "needs_permission");
    assert.match(codexDomain, /Claude only/u);
    assert.equal(textAt(denied.json, "action"), "denied");
    assert.equal(textAt(done, "action"), "done");
    assert.deepEqual(at(settingsOf(args), "sandbox", "network"), { allowedDomains: ["registry.npmjs.org"], strictAllowlist: true });
  },
  narrowGrants = async (): Promise<void> => {
    const run = await setup({
        "dev-stark-1": [{ requestPermission: { need: "network", why: "x" } }, {}],
        "plan-methode-1": [{ requestPermission: { need: "network: registry.npmjs.org", why: "check a version" } }, {}],
      }),
      asked = await started(run);
    assert.equal(textAt(asked, "action"), "needs_permission");
    await refusedTools(run);
    await refusedHome(run);
    await domainGranted(run);
  };

await test("a need DENKEN already denied is denied again without stopping; a role that keeps asking needs the user", deniedAgain);
await test("grants stay narrow: wildcard tools, and domains or tools for Codex, are refused; a domain reaches Claude's sandbox", narrowGrants);
