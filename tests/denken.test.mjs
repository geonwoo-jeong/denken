// End-to-end tests for the DENKEN run engine and config, using fake claude/codex CLIs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(here, "..", "skills", "denken", "scripts");
const FAKE = join(here, "fake-agent.mjs");

const finding = (topic, extra = {}) => ({ severity: "blocking", topic, file: "src.txt", line_start: 1, line_end: 1, criterion: null, problem: `${topic} problem`, required_change: `fix ${topic}`, ...extra });
const changes = (...findings) => ({ review: { verdict: "CHANGES_REQUESTED", findings, checked: [] } });

function setup(scenario = {}, config = null) {
  const dir = mkdtempSync(join(tmpdir(), "denken-test-"));
  const bin = join(dir, "bin");
  const proj = join(dir, "proj");
  mkdirSync(bin);
  mkdirSync(proj);
  chmodSync(FAKE, 0o755);
  for (const cli of ["claude", "codex"]) symlinkSync(FAKE, join(bin, cli));
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SCENARIO: scenarioPath, DENKEN_SKIP_AUTH_CHECK: "1", XDG_CONFIG_HOME: join(dir, "xdg") };
  const sh = (cmd, ...args) => spawnSync(cmd, args, { cwd: proj, env, encoding: "utf8" });
  sh("git", "init", "-q");
  writeFileSync(join(proj, "a.txt"), "a\n");
  writeFileSync(join(proj, "src.txt"), "src\n");
  sh("git", "add", ".");
  sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  if (config) {
    mkdirSync(join(proj, ".denken"), { recursive: true });
    writeFileSync(join(proj, ".denken", "config.json"), JSON.stringify(config));
  }

  const node = (script, ...args) => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: proj, env, encoding: "utf8" });
    let json = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {}
    if (!json && process.env.DEBUG_DENKEN) console.error(args, r.stdout, r.stderr);
    return { ...r, json };
  };
  const denken = (...args) => node("denken.mjs", ...args);
  const created = denken("new", "test task").json;
  const run = created.run;
  writeFileSync(join(proj, run, "brief.md"), "# Brief\n\n1. criterion one\n");
  const drive = () => {
    for (let i = 0; i < 20; i++) {
      const r = denken("next", run, "--wait", "60");
      if (!r.json) throw new Error(`next printed no JSON (exit ${r.status}): ${r.stdout}${r.stderr}`);
      if (r.json.action !== "running") return r.json;
    }
    throw new Error("run did not settle");
  };
  // Log lines are "<cli> <call> <ro|rw> <net|nonet|->"; calls() drops the network column.
  const callsFull = () => (existsSync(`${scenarioPath}.log`) ? readFileSync(`${scenarioPath}.log`, "utf8").trim().split("\n") : []);
  const calls = () => callsFull().map((line) => line.split(" ").slice(0, 3).join(" "));
  const state = () => JSON.parse(readFileSync(join(proj, run, "state.json"), "utf8"));
  return { proj, run, sh, node, denken, drive, calls, callsFull, state };
}

test("happy path alternates providers and reviewers run read-only", () => {
  const t = setup({ "plan-richter-1": changes(finding("scope", { file: "plan.md" })) });
  assert.equal(t.denken("start", t.run).json.action, "started");
  const done = t.drive();
  assert.equal(done.action, "done");
  assert.deepEqual(t.calls(), [
    "claude plan-methode-1 rw",
    "codex plan-richter-1 ro",
    "claude plan-methode-2 rw",
    "codex plan-richter-2 ro",
    "codex dev-stark-1 rw",
    "claude dev-richter-1 ro",
    "claude qa-genau-1 rw",
    "claude wiki-serie-1 rw",
    "codex wiki-richter-1 ro",
  ]);
  assert.ok(Object.values(t.state().approved).every(Boolean));
  assert.ok(existsSync(join(t.proj, ".denken", ".gitignore")));
});

test("a topic raised three times asks DENKEN for a ruling; uphold continues the loop", () => {
  const t = setup({ "dev-richter-1": changes(finding("error handling")), "dev-richter-2": changes(finding("Error-Handling")), "dev-richter-3": changes(finding("error-handling")) });
  t.denken("start", t.run);
  const ruling = t.drive();
  assert.equal(ruling.action, "needs_ruling");
  assert.equal(ruling.reason, "topic_repeated");
  assert.equal(ruling.identity, "src.txt::error-handling");
  assert.equal(ruling.occurrences.length, 3);
  assert.equal(t.denken("rule", t.run, "--decision", "uphold", "--note", "Handle the timeout case as the reviewer says.").json.action, "ruled");
  assert.equal(t.drive().action, "done");
  assert.ok(t.calls().includes("codex dev-stark-4 rw"));
  assert.match(readFileSync(join(t.proj, t.run, "rulings.md"), "utf8"), /R1 · dev · src.txt::error-handling · uphold/);
});

test("dismissing the only open topic approves the stage", () => {
  const t = setup({ "plan-richter-1": changes(finding("naming", { file: "plan.md" })), "plan-richter-2": changes(finding("naming", { file: "plan.md" })), "plan-richter-3": changes(finding("naming", { file: "plan.md" })) });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "needs_ruling");
  t.denken("rule", t.run, "--decision", "dismiss", "--note", "Naming is a preference, not a requirement.");
  assert.equal(t.drive().action, "done");
  assert.ok(!t.calls().includes("claude plan-methode-4 rw"));
  assert.ok(t.state().deferred.some((d) => d.severity === "dismissed"));
});

test("QA failure sends work back to dev, which is reviewed again before QA reruns", () => {
  const fail2 = { qa: { result: "FAIL", criteria: [{ id: 1, criterion: "c1", how_verified: "x", result: "PASS", evidence: "", reproduce: null }, { id: 2, criterion: "c2", how_verified: "x", result: "FAIL", evidence: "boom", reproduce: "npm test" }] } };
  const t = setup({ "qa-genau-1": fail2 });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const calls = t.calls();
  assert.deepEqual(calls.slice(calls.indexOf("claude qa-genau-1 rw")), ["claude qa-genau-1 rw", "codex dev-stark-2 rw", "claude dev-richter-2 ro", "claude qa-genau-2 rw", "claude wiki-serie-1 rw", "codex wiki-richter-1 ro"]);
  assert.equal(t.state().counts.dev["criterion-2"], 1);
  assert.match(readFileSync(join(t.proj, t.run, "calls", "dev-stark-2.prompt.md"), "utf8"), /qa-genau-1\.out\.json/);
});

test("nonblocking findings are deferred and do not block approval", () => {
  const t = setup({ "plan-richter-1": { review: { verdict: "APPROVED", findings: [{ ...finding("typo"), severity: "nonblocking" }], checked: [] } } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.ok(!t.calls().includes("claude plan-methode-2 rw"));
  assert.equal(t.state().deferred.length, 1);
});

test("a stalled loop asks for a ruling even when topics differ", () => {
  const t = setup({ "plan-richter-1": changes(finding("a")), "plan-richter-2": changes(finding("b")), "plan-richter-3": changes(finding("c")) });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.action, "needs_ruling");
  assert.equal(r.reason, "stalled");
});

test("a reviewer that edits the project is rejected until the user resolves it", () => {
  const t = setup({ "dev-richter-1": [{ touch: "a.txt" }, {}] });
  t.denken("start", t.run);
  const blocked = t.drive();
  assert.equal(blocked.action, "needs_user");
  assert.equal(blocked.reason, "guard_violation");
  assert.match(blocked.violations[0], /project files changed/);
  t.sh("git", "checkout", "--", "a.txt");
  assert.equal(t.denken("retry", t.run).json.action, "resumed");
  assert.equal(t.drive().action, "done");
});

test("a worker that edits DENKEN's state is rejected", () => {
  const t = setup({ "dev-stark-1": { touch: "$RUN/state.json" } });
  t.denken("start", t.run);
  const blocked = t.drive();
  assert.equal(blocked.reason, "guard_violation");
  assert.match(blocked.violations.join("\n"), /DENKEN file changed: .*state\.json \(restored\)/);
  assert.equal(t.state().stage, "dev");
});

test("a reviewer that edits an ignored .env file is rejected; QA may rewrite other ignored files", () => {
  const t = setup({ "plan-richter-1": { touch: ".env" } });
  writeFileSync(join(t.proj, ".gitignore"), ".env\ncoverage.xml\n");
  writeFileSync(join(t.proj, ".env"), "SECRET=1\n");
  writeFileSync(join(t.proj, "coverage.xml"), "<old/>\n");
  t.sh("git", "add", ".gitignore");
  t.sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore");
  t.denken("start", t.run);
  assert.match(t.drive().violations.join("\n"), /ignored file changed: \.env/);

  const q = setup({ "qa-genau-1": { touch: "coverage.xml" } });
  writeFileSync(join(q.proj, ".gitignore"), "coverage.xml\n");
  writeFileSync(join(q.proj, "coverage.xml"), "<old/>\n");
  q.sh("git", "add", ".gitignore");
  q.sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore");
  q.denken("start", q.run);
  assert.equal(q.drive().action, "done");
});

test("a dismissed criterion no longer fails QA", () => {
  const fail = { qa: { result: "FAIL", criteria: [{ id: 1, criterion: "c1", how_verified: "x", result: "FAIL", evidence: "needs network", reproduce: "npm test" }] } };
  const t = setup({ "qa-genau-1": fail, "qa-genau-2": fail, "qa-genau-3": fail, "qa-genau-4": fail }, { limits: { topicRepeats: 2 } });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.action, "needs_ruling");
  assert.equal(r.identity, "criterion-1");
  t.denken("rule", t.run, "--decision", "dismiss", "--note", "Criterion 1 needs network access; out of scope for this environment.");
  assert.equal(t.drive().action, "done");
});

test("the planner may not change project files", () => {
  const t = setup({ "plan-methode-1": { touch: "a.txt" } });
  t.denken("start", t.run);
  assert.equal(t.drive().reason, "guard_violation");
});

test("a failed call is retried once, then blocks; usage limits block immediately", () => {
  const t = setup({ "plan-methode-1": [{ fail: "boom" }, { fail: "boom" }] });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.reason, "call_failed");
  assert.equal(t.calls().length, 2);

  const u = setup({ "plan-methode-1": [{ fail: "Error: usage limit reached, try again at 5pm" }, {}] });
  u.denken("start", u.run);
  assert.equal(u.drive().reason, "usage_limit");
  u.denken("retry", u.run);
  assert.equal(u.drive().action, "done");
});

test("output that does not match the schema is retried", () => {
  const t = setup({ "plan-richter-1": [{ review: { findings: [] } }, {}] });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.equal(t.calls().filter((c) => c.includes("plan-richter-1")).length, 2);
});

test("repeated permission denials in work calls stop the run", () => {
  const denial = { denials: [{ tool_name: "Bash", tool_input: { command: "curl example.com" } }] };
  const t = setup({ "plan-methode-1": denial, "plan-richter-1": changes(finding("x", { file: "plan.md" })), "plan-methode-2": denial });
  t.denken("start", t.run);
  assert.equal(t.drive().reason, "repeated_permission_denials");
  assert.match(readFileSync(join(t.proj, t.run, "calls", "plan-richter-1.prompt.md"), "utf8"), /1 action\(s\) blocked/);
});

test("config: explicit worker/reviewer conflict is refused; single provider falls back with a warning", () => {
  const t = setup();
  const conflict = t.node("config.mjs", "set", "richter.plan", "claude");
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /reviewer must use a different provider/);
  assert.ok(!existsSync(join(t.proj, ".denken", "config.json")));

  assert.equal(t.node("config.mjs", "set", "providers", "codex").status, 0);
  const r = t.node("config.mjs", "--json").json;
  assert.equal(r.crossProvider, false);
  assert.equal(r.stages.dev.reviewer.provider, "codex");
  assert.ok(r.warnings.some((w) => /same model checks its own work in plan, dev, wiki, qa/.test(w)));

  assert.equal(t.node("config.mjs", "set", "richter.effort", "high", "--local").status, 0);
  assert.equal(t.node("config.mjs", "set", "genau.effort", "high", "--local").status, 0);
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
  assert.deepEqual(net, { "plan-methode-1": "nonet", "plan-richter-1": "-", "dev-stark-1": "net", "dev-richter-1": "-", "qa-genau-1": "net", "wiki-serie-1": "nonet", "wiki-richter-1": "-" });
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
  const lock = join(t.proj, `${t.run}.lock`);
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
  const t = setup({ "dev-richter-1": changes(finding("error handling timeout")), "dev-richter-2": changes(finding("timeout error handling logic")), "dev-richter-3": changes(finding("handling-timeout-errors")) });
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
