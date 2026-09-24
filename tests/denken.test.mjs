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

const SPEC = "# Spec: test\n\n## Goal\nTest.\n\n## In scope\n- S1. One. Done when: one works.\n- S2. Two. Done when: two works.\n\n## Out of scope\n- X1. Three.\n";
const finding = (topic, extra = {}) => ({ severity: "blocking", topic, file: "src.txt", line_start: 1, line_end: 1, spec_item: null, todo: null, problem: `${topic} problem`, required_change: `fix ${topic}`, ...extra });
const qaItem = (id, result = "PASS", extra = {}) => ({ id, spec_item: id, check: `check ${id}`, how_verified: "x", result, evidence: result === "PASS" ? "ok" : "boom", reproduce: result === "PASS" ? null : "npm test", ...extra });
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
  writeFileSync(join(proj, run, "spec.md"), SPEC);
  // drive() confirms the TODO lists on the user's behalf unless told not to.
  const drive = ({ autoConfirm = true } = {}) => {
    for (let i = 0; i < 20; i++) {
      const r = denken("next", run, "--wait", "60");
      if (!r.json) throw new Error(`next printed no JSON (exit ${r.status}): ${r.stdout}${r.stderr}`);
      if (autoConfirm && r.json.reason === "confirm_todos") {
        assert.equal(denken("confirm", run, "--user-said", "Looks good, go ahead.").json.action, "confirmed");
        continue;
      }
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
  const t = setup({ "plan-richter-1": changes(finding("scope", { file: "todo-dev.md" })) });
  assert.equal(t.denken("start", t.run).json.action, "started");
  const done = t.drive();
  assert.equal(done.action, "done", JSON.stringify(done).slice(0, 600));
  assert.deepEqual(t.calls(), [
    "claude plan-methode-1 rw",
    "codex plan-richter-1 ro",
    "claude plan-methode-2 rw",
    "codex plan-richter-2 ro",
    "codex dev-stark-1 rw",
    "claude dev-ubel-1 ro",
    "claude qa-genau-1 rw",
    "claude wiki-serie-1 rw",
    "codex wiki-frieren-1 ro",
  ]);
  assert.ok(Object.values(t.state().approved).every(Boolean));
  assert.ok(existsSync(join(t.proj, ".denken", ".gitignore")));
});

test("a topic raised three times asks DENKEN for a ruling; uphold continues the loop", () => {
  const t = setup({ "dev-ubel-1": changes(finding("error handling")), "dev-ubel-2": changes(finding("Error-Handling")), "dev-ubel-3": changes(finding("error-handling")) });
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
  const t = setup({ "plan-richter-1": changes(finding("naming", { file: "todo-dev.md" })), "plan-richter-2": changes(finding("naming", { file: "todo-dev.md" })), "plan-richter-3": changes(finding("naming", { file: "todo-dev.md" })) });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "needs_ruling");
  t.denken("rule", t.run, "--decision", "dismiss", "--note", "Naming is a preference, not a requirement.");
  assert.equal(t.drive().action, "done");
  assert.ok(!t.calls().includes("claude plan-methode-4 rw"));
  assert.ok(t.state().deferred.some((d) => d.severity === "dismissed"));
});

test("QA failure sends work back to dev, which is reviewed again before QA reruns", () => {
  const fail2 = { qa: { result: "FAIL", items: [qaItem(1), qaItem(2, "FAIL")] } };
  const t = setup({ "qa-genau-1": fail2 });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const calls = t.calls();
  assert.deepEqual(calls.slice(calls.indexOf("claude qa-genau-1 rw")), ["claude qa-genau-1 rw", "codex dev-stark-2 rw", "claude dev-ubel-2 ro", "claude qa-genau-2 rw", "claude wiki-serie-1 rw", "codex wiki-frieren-1 ro"]);
  assert.equal(t.state().counts.dev["spec-2"], 1);
  // STARK gets only the failed checks, not the QA report or the QA TODO list.
  const prompt = readFileSync(join(t.proj, t.run, "calls", "dev-stark-2.prompt.md"), "utf8");
  assert.match(prompt, /qa-genau-1\.failures\.json/);
  assert.doesNotMatch(prompt, /qa-genau-1\.out\.json|todo-qa\.md/);
  assert.deepEqual(JSON.parse(readFileSync(join(t.proj, t.run, "calls", "qa-genau-1.failures.json"), "utf8")).map((f) => f.qa_item), ["Q2"]);
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
  const t = setup({ "dev-ubel-1": [{ touch: "a.txt" }, {}] });
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

test("a dismissed spec item no longer fails QA", () => {
  const fail = { qa: { result: "FAIL", items: [qaItem(1, "FAIL"), qaItem(2)] } };
  const t = setup({ "qa-genau-1": fail, "qa-genau-2": fail, "qa-genau-3": fail, "qa-genau-4": fail }, { limits: { topicRepeats: 2 } });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.action, "needs_ruling");
  assert.equal(r.identity, "spec-1");
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

test("start refuses a spec without in-scope and out-of-scope sections", () => {
  const t = setup();
  writeFileSync(join(t.proj, t.run, "spec.md"), "# Spec\n\n## Goal\nSomething.\n");
  const r = t.denken("start", t.run);
  assert.equal(r.status, 1);
  assert.match(r.json.error, /In scope.*Out of scope/s);
  writeFileSync(join(t.proj, t.run, "spec.md"), "# Spec\n\n## In scope\n- S1. One. Done when: it works.\n\n## Out of scope\n- None\n");
  assert.equal(t.denken("start", t.run).json.action, "started");
});

test("development waits until the user confirms the TODO lists; a change request replans", () => {
  const t = setup();
  t.denken("start", t.run);
  const gate = t.drive({ autoConfirm: false });
  assert.equal(gate.action, "needs_user");
  assert.equal(gate.reason, "confirm_todos");
  assert.deepEqual(gate.files.map((f) => f.split("/").pop()), ["spec.md", "todo-dev.md", "todo-qa.md"]);
  assert.ok(!t.calls().some((c) => c.includes("dev-stark")));
  assert.equal(t.denken("retry", t.run).status, 1);
  assert.equal(t.denken("rule", t.run, "--decision", "uphold", "--note", "x").status, 1);

  assert.equal(t.denken("rule", t.run, "--decision", "replan", "--note", "The user wants D2 split in two.").json.action, "ruled");
  assert.equal(t.drive({ autoConfirm: false }).reason, "confirm_todos");
  assert.ok(t.calls().includes("claude plan-methode-2 rw"));
  assert.match(readFileSync(join(t.proj, t.run, "calls", "plan-methode-2.prompt.md"), "utf8"), /rulings\.md/);
  assert.equal(t.denken("confirm", t.run).status, 1);
  assert.equal(t.denken("confirm", t.run, "--user-said", "Yes, build it.").json.action, "confirmed");
  assert.equal(t.state().confirmed.userSaid, "Yes, build it.");
  assert.equal(t.drive().action, "done");
});

test("each role reads only its inputs: STARK the dev TODO, GENAU the spec and QA TODO, reviewers the spec", () => {
  const t = setup();
  t.denken("start", t.run);
  t.drive();
  const reads = (call) => {
    const prompt = readFileSync(join(t.proj, t.run, "calls", `${call}.prompt.md`), "utf8");
    return prompt.match(/- Read:\n((?: {2}- .+\n)+)/)[1].split("\n").filter(Boolean).map((l) => l.split("/").pop());
  };
  assert.deepEqual(reads("plan-methode-1"), ["spec.md"]);
  assert.deepEqual(reads("plan-richter-1"), ["spec.md", "todo-dev.md", "todo-qa.md"]);
  assert.deepEqual(reads("dev-stark-1"), ["todo-dev.md"]);
  assert.deepEqual(reads("dev-ubel-1"), ["spec.md", "todo-dev.md", "dev-report.md", "dev-ubel-1.diff"]);
  assert.deepEqual(reads("qa-genau-1"), ["spec.md", "todo-qa.md"]);
  assert.ok(reads("wiki-frieren-1").includes("spec.md"));
  // Each stage has its own reviewer, whose prompt adds the rules every reviewer shares.
  for (const [call, name] of [["plan-richter-1", "RICHTER"], ["dev-ubel-1", "UBEL"], ["wiki-frieren-1", "FRIEREN"]]) {
    const prompt = readFileSync(join(t.proj, t.run, "calls", `${call}.prompt.md`), "utf8");
    assert.ok(prompt.startsWith(`# ${name}:`));
    assert.match(prompt, /## How every DENKEN reviewer works/);
  }
});

test("TODO lists with coverage gaps go straight back to METHODE, each gap with its own identity", () => {
  const todoDev = "## Acceptance\n- S1. One. Done when: one works!\n\n## TODO\n- [ ] D1 (S1) one\n- [ ] D2 (X1) three\n- D3 (S1) no checkbox\n";
  const todoQa = "## Checks\n- [ ] Q1 (S1) one\n\n## Notes\n- Q1 already covers S1; this prose line is not an item.\n";
  const t = setup({ "plan-methode-1": { todoDev, todoQa } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  // No review was spent on the gapped lists.
  assert.deepEqual(t.calls().slice(0, 3), ["claude plan-methode-1 rw", "claude plan-methode-2 rw", "codex plan-richter-2 ro"]);
  const gaps = t.state().findings.plan.filter((f) => f.source === "engine");
  assert.deepEqual([...new Set(gaps.map((g) => g.identity))].sort(), ["spec-2", "todo-D2", "todo-acceptance-S1", "todo-acceptance-S2", "todo-do-not-build-X1", "todo-format-D3"]);
  assert.ok(gaps.some((g) => g.problem === "S1 in the Acceptance section of todo-dev.md differs from spec.md"));
  assert.ok(!gaps.some((g) => /Q1/.test(g.problem)));
  assert.match(readFileSync(join(t.proj, t.run, "calls", "plan-methode-2.prompt.md"), "utf8"), /plan-methode-1\.gaps\.json/);
});

test("a Q item missing from the QA report counts as a failure", () => {
  const t = setup({ "qa-genau-1": { qa: { result: "PASS", items: [qaItem(1)] } } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.ok(t.calls().includes("codex dev-stark-2 rw"));
  const failures = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "qa-genau-1.failures.json"), "utf8"));
  assert.deepEqual(failures.map((f) => [f.qa_item, f.spec_item, f.evidence]), [["Q2", 2, "missing from the QA report"]]);
});

test("STARK may not edit the TODO lists or the spec", () => {
  const t = setup({ "dev-stark-1": { touch: "$RUN/todo-dev.md" } });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.reason, "guard_violation");
  assert.match(r.violations.join("\n"), /todo-dev\.md \(restored\)/);
  assert.doesNotMatch(readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8"), /tampered/);
});

test("start refuses open clarification markers and S items without Done when", () => {
  const t = setup();
  writeFileSync(join(t.proj, t.run, "spec.md"), "## In scope\n- S1. One. Done when: it works.\n- S2. Two.\n\n## Out of scope\n- None\n\n[NEEDS CLARIFICATION: which encoding?]\n");
  const r = t.denken("start", t.run);
  assert.equal(r.status, 1);
  assert.match(r.json.error, /S2 needs a "Done when:"/);
  assert.match(r.json.error, /which encoding\?/);
});

test("open questions in the development TODO must be answered before development starts", () => {
  const withQuestion = "## Acceptance\n- S1. One. Done when: one works.\n- S2. Two. Done when: two works.\n\n## Do not build\n- X1. Three.\n\n## TODO\n- [ ] D1 (S1) one\n- [ ] D2 (S2) two\n\n## Open questions\n- Should errors be logged?\n";
  const t = setup({ "plan-methode-1": { todoDev: withQuestion } });
  t.denken("start", t.run);
  const gate = t.drive({ autoConfirm: false });
  assert.deepEqual(gate.openQuestions, ["Should errors be logged?"]);
  const refused = t.denken("confirm", t.run, "--user-said", "ok");
  assert.equal(refused.status, 1);
  assert.match(refused.json.error, /open questions/);
  writeFileSync(join(t.proj, t.run, "spec.md"), `${readFileSync(join(t.proj, t.run, "spec.md"), "utf8")}\n## Decisions\n- Should errors be logged? → No.\n`);
  t.denken("rule", t.run, "--decision", "replan", "--note", "The user answered: errors are not logged.");
  assert.deepEqual(t.drive({ autoConfirm: false }).openQuestions, []);
  assert.equal(t.denken("confirm", t.run, "--user-said", "ok").json.action, "confirmed");
  assert.equal(t.drive().action, "done");
});

test("a change after confirmation stops the run; spec or dev TODO changes need a replan", () => {
  const t = setup();
  t.denken("start", t.run);
  t.drive({ autoConfirm: false });
  t.denken("confirm", t.run, "--user-said", "Approved.");
  const spec = join(t.proj, t.run, "spec.md");
  const original = readFileSync(spec, "utf8");
  writeFileSync(spec, original.replace("- X1. Three.", "- X1. Three.\n- X2. Four."));
  const r = t.drive({ autoConfirm: false });
  assert.equal(r.reason, "scope_changed");
  assert.deepEqual(r.changed, ["spec"]);
  assert.ok(!t.calls().some((c) => c.includes("dev-stark")));
  assert.match(t.denken("confirm", t.run, "--user-said", "Fine.").json.error, /no reviewer has checked the new content/);
  // Restoring what the user approved lets the run continue.
  writeFileSync(spec, original);
  assert.equal(t.denken("confirm", t.run, "--user-said", "Approved again.").json.action, "confirmed");
  // A change to the QA TODO alone can be approved directly.
  const qa = join(t.proj, t.run, "todo-qa.md");
  writeFileSync(qa, readFileSync(qa, "utf8").replace("check two", "check two, more carefully"));
  assert.deepEqual(t.drive({ autoConfirm: false }).changed, ["todoQa"]);
  assert.equal(t.denken("confirm", t.run, "--user-said", "OK, the QA change is fine.").json.action, "confirmed");
  assert.equal(t.drive().action, "done");
  assert.equal(t.state().confirmations.length, 3);
});

test("a QA report with items that are not in todo-qa.md is rejected and retried", () => {
  const t = setup({ "qa-genau-1": [{ qa: { result: "FAIL", items: [qaItem(1), qaItem(2), qaItem(99, "FAIL")] } }, {}] });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.equal(t.calls().filter((c) => c.includes("qa-genau-1")).length, 2);
  assert.ok(!t.calls().includes("codex dev-stark-2 rw"));
});

test("after a QA failure, the dev reviewer checks that the fix is general", () => {
  const t = setup({ "qa-genau-1": { qa: { result: "FAIL", items: [qaItem(1), qaItem(2, "FAIL")] } } });
  t.denken("start", t.run);
  t.drive();
  const prompt = readFileSync(join(t.proj, t.run, "calls", "dev-ubel-2.prompt.md"), "utf8");
  assert.match(prompt, /qa-genau-1\.failures\.json/);
  assert.match(prompt, /special-casing/);
});

test("STARK ticks D items off in todo-dev.md, and may change nothing else there", () => {
  const t = setup();
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const todo = readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8");
  assert.match(todo, /- \[x\] D1 \(S1\)/);
  assert.match(todo, /- \[x\] D2 \(S2\)/);
  // Ticking is not a change to what the user confirmed.
  assert.ok(!t.calls().some((c) => c.includes("dev-stark-2")));
});

test("a D item neither ticked off nor reported blocked goes straight back to STARK", () => {
  const t = setup({ "dev-stark-1": { tick: [1] } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const calls = t.calls();
  assert.deepEqual(calls.slice(calls.indexOf("codex dev-stark-1 rw"), calls.indexOf("codex dev-stark-1 rw") + 3), ["codex dev-stark-1 rw", "codex dev-stark-2 rw", "claude dev-ubel-2 ro"]);
  const gaps = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.gaps.json"), "utf8"));
  assert.deepEqual(gaps.findings.map((f) => f.identity), ["todo-D2"]);
});

test("a D item reported blocked goes to UBEL, who sees each item's status and the change scope", () => {
  const todoDev = "## Acceptance\n- S1. One. Done when: one works.\n- S2. Two. Done when: two works.\n\n## Do not build\n- X1. Three.\n\n## TODO\n- [ ] D1 (S1) build one. Files: `lib/one.js`, `test/one.test.js`.\n- [ ] D2 (S2) build two. Files: `src.txt`.\n  - sub-note naming `lib/extra.js`\n\n## Open questions\n- None\n";
  const t = setup({ "plan-methode-1": { todoDev }, "dev-stark-1": { tick: [1], report: "## TODO status\n- D1 done\n- D2 blocked: needs a design decision\n" } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.ok(t.calls().includes("claude dev-ubel-1 ro"));
  const prompt = readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.prompt.md"), "utf8");
  assert.match(prompt, /TODO status and recorded test runs: D1 \[x\], test run: `echo ok` exit 0 \(ok\), D2 \[ \] reported blocked/);
  assert.match(prompt, /Files changed in this stage: src\.txt/);
  assert.match(prompt, /Changed files that no D item names: none/);
  assert.match(prompt, /Ticked D items none of whose named files changed: D1 \(lib\/one\.js, test\/one\.test\.js\)/);
  assert.match(prompt, /Ticked D items with no named test file added or changed: D1\./);
});

test("UBEL is told about changed files that no D item names", () => {
  const t = setup();
  t.denken("start", t.run);
  t.drive();
  assert.match(readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.prompt.md"), "utf8"), /Changed files that no D item names: src\.txt\./);
});

test("a tick without a recorded passing test run, or a failing one, goes back to STARK", () => {
  const t = setup({ "dev-stark-1": { tickByHand: [1], tickFail: [2] } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const gaps = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.gaps.json"), "utf8")).findings;
  assert.deepEqual(gaps.map((g) => [g.identity, g.problem]), [
    ["todo-D1", "D1 is ticked, but no passing test run was recorded for it"],
    ["todo-D2", "D2 is neither ticked off nor reported blocked in dev-report.md"],
  ]);
  assert.match(readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.tick-D2.log"), "utf8"), /\[exit 1\]/);
  assert.ok(!t.calls().includes("claude dev-ubel-1 ro"));
});

test("STARK may only tick D items in the TODO section: unticking or ticking other lines is undone", () => {
  const t = setup({ "dev-ubel-1": changes(finding("x")), "dev-stark-2": { untickByHand: [1], tick: [] } });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.reason, "guard_violation");
  assert.equal(r.call, "dev-stark-2");
  assert.match(readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8"), /- \[x\] D1/);

  const todoDev = "## Acceptance\n- S1. One. Done when: one works.\n- S2. Two. Done when: two works.\n\n## Do not build\n- X1. Three.\n\n## TODO\n- [ ] D1 (S1) one\n- [ ] D2 (S2) two\n- [ ] note: keep it small\n\n## Open questions\n- None\n";
  const u = setup({ "plan-methode-1": { todoDev }, "dev-stark-1": { tickOther: "note" } });
  u.denken("start", u.run);
  assert.equal(u.drive().reason, "guard_violation");
});

test("after a QA failure the engine unticks the D items for the failing spec item", () => {
  const t = setup({ "qa-genau-1": { qa: { result: "FAIL", items: [qaItem(1), qaItem(2, "FAIL")] } }, "dev-stark-2": { tick: [] } });
  t.denken("start", t.run);
  t.drive();
  // D2 serves S2 and was unticked; STARK's second round did not re-tick it with a test run.
  const gaps = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-stark-2.gaps.json"), "utf8")).findings;
  assert.deepEqual(gaps.map((g) => g.identity), ["todo-D2"]);
  assert.ok(t.state().untickedAt.D2);
  assert.ok(!t.state().untickedAt.D1);
});

test("the tick command refuses outside a development call", () => {
  const t = setup();
  t.denken("start", t.run);
  const r = t.denken("tick", t.run, "D1", "--", "true");
  assert.equal(r.status, 1);
  assert.match(r.json.error, /only for STARK|for STARK, during a development call/);
});

test("UBEL is told about deleted test lines, added skip markers, and files under a named directory", () => {
  const todoDev = "## Acceptance\n- S1. One. Done when: one works.\n- S2. Two. Done when: two works.\n\n## Do not build\n- X1. Three.\n\n## TODO\n- [ ] D1 (S1) one. Files: `lib/`, `test/b.test.js`.\n- [ ] D2 (S2) two.\n\n## Open questions\n- None\n";
  const t = setup({ "plan-methode-1": { todoDev }, "dev-stark-1": { editFiles: { "lib/x.js": "export const x = 1;\n", "test/b.test.js": "test.skip('one', () => {});\n" } } });
  mkdirSync(join(t.proj, "test"));
  writeFileSync(join(t.proj, "test", "b.test.js"), "test('one', () => {});\ntest('two', () => {});\n");
  t.sh("git", "add", ".");
  t.sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "tests");
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const prompt = readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.prompt.md"), "utf8");
  assert.match(prompt, /Changed files that no D item names: src\.txt\./);
  assert.match(prompt, /Ticked D items that name no files: D2\./);
  assert.match(prompt, /Lines deleted from test files: test\/b\.test\.js \(2\)/);
  assert.match(prompt, /Skip markers added: test\/b\.test\.js: test\.skip\('one', \(\) => \{\}\);/);
});

test("the tick command runs its argv without a shell", () => {
  const t = setup({ "dev-stark-1": { tickArgs: ["node", "-e", "console.log(process.argv[1]); process.exit(process.argv[1] === 'login flow' ? 0 : 1)", "login flow"] } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const ledger = readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.ticks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((e) => [e.item, e.lastLine]), [["D1", "login flow"], ["D2", "login flow"]]);
  assert.match(ledger[0].command, /'login flow'$/);

  // "|| true" is just more arguments to false, so the failure stands and nothing is ticked.
  const u = setup({ "dev-stark-1": { tickArgs: ["false", "||", "true"] } });
  u.denken("start", u.run);
  u.drive();
  const gaps = JSON.parse(readFileSync(join(u.proj, u.run, "calls", "dev-stark-1.gaps.json"), "utf8")).findings;
  assert.deepEqual(gaps.map((g) => g.identity), ["todo-D1", "todo-D2"]);
});
