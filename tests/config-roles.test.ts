// DENKEN engine tests: the configuration of roles, providers and network. Shared setup is in helpers.ts.
import type { JsonValue, TestRun } from "./test-types.ts";
import { at, listAt, textAt } from "./test-json.ts";
import assert from "node:assert/strict";
import { fileExists } from "./test-log.ts";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const OK = 0,
  FAILED = 1,
  NONE = 0,
  SAME_MODEL = /same model checks its own work in plan, dev, wiki, qa.*\(richter, ubel, frieren, genau\)/u,
  DEFAULT_NETWORK: Readonly<Record<string, string>> = {
    "dev-stark-1": "net",
    "dev-ubel-1": "-",
    "plan-methode-1": "nonet",
    "plan-richter-1": "-",
    "qa-genau-1": "net",
    "wiki-frieren-1": "-",
    "wiki-serie-1": "nonet",
  },
  strings = (values: readonly JsonValue[]): readonly string[] => values.filter((value): value is string => typeof value === "string"),
  // With every checker on another effort, the same provider no longer checks its own work.
  differentEfforts = async (run: TestRun): Promise<void> => {
    const set = [
        await run.node("config.ts", "set", "richter.effort", "high", "--local"),
        await run.node("config.ts", "set", "ubel.effort", "high", "--local"),
        await run.node("config.ts", "set", "frieren.effort", "high", "--local"),
        await run.node("config.ts", "set", "genau.effort", "high", "--local"),
      ],
      resolved = await run.node("config.ts", "--json");
    assert.ok(set.every((result) => result.status === OK));
    assert.equal(listAt(resolved.json, "warnings").length, NONE);
  },
  singleProvider = async (run: TestRun): Promise<void> => {
    const set = await run.node("config.ts", "set", "providers", "codex"),
      resolved = await run.node("config.ts", "--json");
    assert.equal(set.status, OK);
    assert.equal(at(resolved.json, "crossProvider"), false);
    assert.equal(textAt(resolved.json, "stages", "dev", "reviewer", "provider"), "codex");
    assert.ok(strings(listAt(resolved.json, "warnings")).some((warning) => SAME_MODEL.test(warning)));
    await differentEfforts(run);
  },
  conflictRefused = async (): Promise<void> => {
    const run = await setup(),
      conflict = await run.node("config.ts", "set", "richter", "claude"),
      saved = await fileExists(path.join(run.proj, ".denken", "config.json"));
    assert.equal(conflict.status, FAILED);
    assert.match(conflict.stderr, /reviewer must use a different provider/u);
    assert.ok(!saved);
    await singleProvider(run);
  },
  unavailableProvider = async (): Promise<void> => {
    const run = await setup({}, { providers: ["claude"], roles: { stark: "codex" } }),
      resolved = await run.node("config.ts", "--json");
    assert.equal(listAt(resolved.json, "errors").length, NONE);
    assert.equal(textAt(resolved.json, "stages", "dev", "worker", "provider"), "claude");
    assert.ok(strings(listAt(resolved.json, "warnings")).some((warning) => /stark is set to codex, which is not in providers/u.test(warning)));
  },
  // Log lines are "<cli> <call> <ro|rw> <net|nonet|->": the network column, by call.
  networkOf = async (run: TestRun): Promise<Readonly<Record<string, string>>> => {
    const lines = await run.callsFull();
    return Object.fromEntries(
      lines.map((line) => {
        const [, call = "", , network = ""] = line.split(" ");
        return [call, network];
      }),
    );
  },
  configuredNetwork = async (): Promise<void> => {
    const run = await setup({}, { roles: { methode: { network: true }, stark: { network: false } } }),
      started = await run.denken("start", run.run),
      done = await run.drive(),
      lines = await run.callsFull();
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.ok(lines.includes("codex dev-stark-1 rw nonet"));
    assert.ok(lines.includes("claude plan-methode-1 rw net"));
  },
  networkDefaults = async (): Promise<void> => {
    const run = await setup(),
      started = await run.denken("start", run.run),
      done = await run.drive(),
      network = await networkOf(run),
      set = await run.node("config.ts", "set", "stark.network", "false");
    assert.equal(textAt(started.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.deepEqual(network, DEFAULT_NETWORK);
    assert.equal(set.status, OK);
    await configuredNetwork();
  };

await test("config: explicit worker/reviewer conflict is refused; single provider falls back with a warning", conflictRefused);
await test("config: a role on an unavailable provider falls back with a warning instead of failing", unavailableProvider);
await test("workers get network by role default; reviewers get none", networkDefaults);
