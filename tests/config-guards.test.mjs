// DENKEN engine tests: config-guards. Shared setup is in helpers.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changes, FAKE, finding, qaItem, REQUEST, SCRIPTS, setup, TWO_UNITS } from "./helpers.mjs";

test("repeated permission denials in work calls stop the run", () => {
  const denial = { denials: [{ tool_name: "Bash", tool_input: { command: "curl example.com" } }] };
  const t = setup({ "plan-methode-1": denial, "plan-richter-1": changes(finding("x", { file: "todo-dev.md" })), "plan-methode-2": denial });
  t.denken("start", t.run);
  assert.equal(t.drive().reason, "repeated_permission_denials");
  assert.match(readFileSync(join(t.proj, t.run, "calls", "plan-richter-1.prompt.md"), "utf8"), /1 action\(s\) blocked/);
});

test("config: explicit worker/reviewer conflict is refused; single provider falls back with a warning", () => {
  const t = setup();
  const conflict = t.node("config.mjs", "set", "richter", "claude");
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /reviewer must use a different provider/);
  assert.ok(!existsSync(join(t.proj, ".denken", "config.json")));

  assert.equal(t.node("config.mjs", "set", "providers", "codex").status, 0);
  const r = t.node("config.mjs", "--json").json;
  assert.equal(r.crossProvider, false);
  assert.equal(r.stages.dev.reviewer.provider, "codex");
  assert.ok(r.warnings.some((w) => /same model checks its own work in plan, dev, wiki, qa.*\(richter, ubel, frieren, genau\)/.test(w)));

  for (const role of ["richter", "ubel", "frieren", "genau"]) assert.equal(t.node("config.mjs", "set", `${role}.effort`, "high", "--local").status, 0);
  assert.equal(t.node("config.mjs", "--json").json.warnings.length, 0);
});

test("config: a role on an unavailable provider falls back with a warning instead of failing", () => {
  const t = setup({}, { providers: ["claude"], roles: { stark: "codex" } });
  const r = t.node("config.mjs", "--json").json;
  assert.equal(r.errors.length, 0);
  assert.equal(r.stages.dev.worker.provider, "claude");
  assert.ok(r.warnings.some((w) => /stark is set to codex, which is not in providers/.test(w)));
});

test("workers get network by role default; reviewers get none", () => {
  const t = setup();
  t.denken("start", t.run);
  t.drive();
  const net = Object.fromEntries(t.callsFull().map((line) => line.split(" ")).map(([, call, , n]) => [call, n]));
  assert.deepEqual(net, { "plan-methode-1": "nonet", "plan-richter-1": "-", "dev-stark-1": "net", "dev-ubel-1": "-", "qa-genau-1": "net", "wiki-serie-1": "nonet", "wiki-frieren-1": "-" });
  assert.equal(t.node("config.mjs", "set", "stark.network", "false").status, 0);
  const u = setup({}, { roles: { stark: { network: false }, methode: { network: true } } });
  u.denken("start", u.run);
  u.drive();
  assert.ok(u.callsFull().includes("codex dev-stark-1 rw nonet"));
  assert.ok(u.callsFull().includes("claude plan-methode-1 rw net"));
});

test("a call that exceeds the timeout is retried once, then blocks", () => {
  const t = setup({ "plan-methode-1": [{ sleepMs: 5000 }, { sleepMs: 5000 }] }, { limits: { callTimeoutMin: 0.02 } });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.action, "needs_user");
  assert.equal(r.reason, "call_timeout");
  assert.equal(t.calls().length, 2);
});

test("only one engine process works on a run at a time; a dead or silent holder's lock is taken over", () => {
  const t = setup();
  t.denken("start", t.run);
  const lock = join(t.proj, ".denken", "locks", `${t.run.split("/").pop()}.lock`);
  const hold = (pid) => {
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), JSON.stringify({ pid, nonce: "other" }));
  };
  hold(process.pid);
  const busy = t.denken("next", t.run, "--wait", "1");
  assert.equal(busy.json.busy, true);
  assert.equal(t.calls().length, 0);
  assert.equal(t.denken("retry", t.run).status, 1);

  // A live pid with a heartbeat older than 30s (for example, a reused pid) is stale too.
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  assert.equal(t.drive().action, "done");
  assert.ok(!existsSync(lock));

  hold(999999);
  assert.equal(t.denken("status", t.run).status, 0);
  assert.equal(t.denken("next", t.run).json.action, "done");
});

test("processes an agent leaves running are stopped when its call ends", () => {
  const t = setup({ "plan-methode-1": { spawnLate: { afterMs: 1500, touch: "a.txt" } } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  assert.equal(readFileSync(join(t.proj, "a.txt"), "utf8"), "a\n");
});

test("a result left by an earlier attempt of the same call is not taken as this attempt's", () => {
  const t = setup({ "plan-methode-1": { staleMeta: true } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.deepEqual(t.state().calls.filter((c) => c.id === "plan-methode-1").map((c) => c.status), ["ok"]);
  assert.ok(readdirSync(join(t.proj, t.run, "calls")).some((f) => /^plan-methode-1\.stale-\d+\.meta\.json$/.test(f)));
});

test("a stage-wide ruling must name each finding it dismisses", () => {
  const t = setup({ "plan-richter-1": changes(finding("a")), "plan-richter-2": changes(finding("b")), "plan-richter-3": changes(finding("c"), finding("d", { file: "other.txt" })) });
  t.denken("start", t.run);
  assert.equal(t.drive().reason, "stalled");
  const blanket = t.denken("rule", t.run, "--decision", "dismiss", "--note", "Good enough.");
  assert.equal(blanket.status, 1);
  assert.match(blanket.json.error, /--identities/);
  assert.equal(t.denken("rule", t.run, "--decision", "dismiss", "--identities", "src.txt::c", "--note", "c is a preference.").json.action, "ruled");
  assert.equal(t.state().stage, "plan");
  assert.ok(t.calls().includes("claude plan-methode-4 rw") || t.drive());
  const u = setup({ "plan-richter-1": changes(finding("a")), "plan-richter-2": changes(finding("b")), "plan-richter-3": changes(finding("c"), finding("d", { file: "other.txt" })) });
  u.denken("start", u.run);
  u.drive();
  u.denken("rule", u.run, "--decision", "dismiss", "--identities", "src.txt::c,other.txt::d", "--note", "Both are preferences.");
  assert.equal(u.state().stage, "dev");
  assert.equal(u.state().deferred.filter((d) => d.severity === "dismissed").length, 2);
});

test("a slightly renamed topic on the same file counts as the same topic", () => {
  const t = setup({ "dev-ubel-1": changes(finding("error handling timeout")), "dev-ubel-2": changes(finding("timeout error handling logic")), "dev-ubel-3": changes(finding("handling-timeout-errors")) });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.reason, "topic_repeated");
  assert.equal(r.identity, "src.txt::error-handling-timeout");
  assert.equal(r.occurrences.length, 3);
});

test("start refuses when the same model would check its own work, unless allowed", () => {
  const t = setup({}, { providers: ["codex"] });
  const refused = t.denken("start", t.run);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.reason, "same_reviewer");
  assert.equal(t.node("config.mjs", "set", "allowSameReviewer", "true").status, 0);
  assert.equal(t.denken("start", t.run).json.action, "started");
  assert.equal(t.drive().action, "done");
  assert.ok(t.calls().every((c) => c.startsWith("codex")));
});

test("start refuses a request without its goal and every section", () => {
  const t = setup();
  writeFileSync(join(t.proj, t.run, "request.md"), "# Request\n\n## Confirmed\n- REQ-001. One. Done when: it works.\n");
  const r = t.denken("start", t.run);
  assert.equal(r.status, 1);
  assert.match(r.json.error, /## Goal[\s\S]*## Out of scope[\s\S]*## Not now[\s\S]*## Cautions/);
  writeFileSync(join(t.proj, t.run, "request.md"), "# Request\n\n## Goal\nOne thing.\n\n## Confirmed\n- REQ-001. One. Done when: it works.\n\n## Out of scope\n- None\n\n## Not now\n- None\n\n## Cautions\n- None\n");
  assert.equal(t.denken("start", t.run).json.action, "started");
});
