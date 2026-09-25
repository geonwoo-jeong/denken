// DENKEN engine tests: loop. Shared setup is in helpers.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changes, FAKE, finding, qaItem, REQUEST, SCRIPTS, setup, TWO_UNITS } from "./helpers.mjs";

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

test("dismissing the only open topic approves the stage", () => {
  const t = setup({ "plan-richter-1": changes(finding("naming", { file: "todo-dev.md" })), "plan-richter-2": changes(finding("naming", { file: "todo-dev.md" })), "plan-richter-3": changes(finding("naming", { file: "todo-dev.md" })) });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "needs_ruling");
  t.denken("rule", t.run, "--decision", "dismiss", "--note", "Naming is a preference, not a requirement.");
  assert.equal(t.drive().action, "done");
  assert.ok(!t.calls().includes("claude plan-methode-4 rw"));
  assert.ok(t.state().deferred.some((d) => d.severity === "dismissed"));
  // The approval that came from the ruling is recorded as such.
  assert.match(readFileSync(join(t.proj, t.state().log, "verdicts.md"), "utf8"), /· Planning review · DENKEN · \*\*APPROVED\*\* \(by ruling R1\) · no blocking finding is left open: todo-dev\.md::naming dismissed → 01-planning\/\d+_denken-ruling-R1-dismiss\.md/);
});

test("QA failure sends work back to dev, which is reviewed again before QA reruns", () => {
  const fail2 = { qa: { result: "FAIL", items: [qaItem(1), qaItem(2, "FAIL")] } };
  const t = setup({ "qa-genau-1": fail2 });
  t.denken("start", t.run);
  const end = t.drive();
  assert.equal(end.action, "done", JSON.stringify(end).slice(0, 600));
  const calls = t.calls();
  assert.deepEqual(calls.slice(calls.indexOf("claude qa-genau-1 rw")), ["claude qa-genau-1 rw", "codex dev-stark-2 rw", "claude dev-ubel-2 ro", "claude qa-genau-2 rw", "claude wiki-serie-1 rw", "codex wiki-frieren-1 ro"]);
  assert.equal(t.state().counts.dev["REQ-002"], 1);
  // STARK gets a recovery TODO written from the failure, not the QA report or the QA TODO list.
  const prompt = readFileSync(join(t.proj, t.run, "calls", "dev-stark-2.prompt.md"), "utf8");
  assert.match(prompt, /todo-fix\.md/);
  assert.match(prompt, /recovery items FIX-001 under "QA cycle 1"/);
  assert.doesNotMatch(prompt, /qa-genau-1\.out\.json|todo-qa\.md/);
  assert.match(readFileSync(join(t.proj, t.run, "todo-fix.md"), "utf8"), /## QA cycle 1\n\n- \[x\] FIX-001 \(QA-002, REQ-002\) Fix: check 2\. Observed: boom\. Reproduce: npm test\./);
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

test("a dismissed request item no longer fails QA", () => {
  const fail = { qa: { result: "FAIL", items: [qaItem(1, "FAIL"), qaItem(2)] } };
  const t = setup({ "qa-genau-1": fail, "qa-genau-2": fail, "qa-genau-3": fail, "qa-genau-4": fail }, { limits: { topicRepeats: 2 } });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.action, "needs_ruling");
  assert.equal(r.reason, "qa_repeated_failure");
  assert.deepEqual(r.identities, ["REQ-001"]);
  t.denken("rule", t.run, "--decision", "dismiss", "--identities", "REQ-001", "--note", "Criterion 1 needs network access; out of scope for this environment.");
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
