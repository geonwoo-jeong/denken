// DENKEN engine tests: qa-wiki-permissions. Shared setup is in helpers.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changes, FAKE, finding, qaItem, REQUEST, SCRIPTS, setup, TWO_UNITS } from "./helpers.mjs";

test("UBEL is told about deleted test lines, added skip markers, and files under a named directory", () => {
  const todoDev = "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) one. Files: `lib/`, `test/b.test.js`.\n- [ ] DEV-002 (REQ-002) two.\n\n## Open questions\n- None\n";
  const t = setup({ "plan-methode-1": { todoDev }, "dev-stark-1": { editFiles: { "lib/x.js": "export const x = 1;\n", "test/b.test.js": "test.skip('one', () => {});\n" } } });
  mkdirSync(join(t.proj, "test"));
  writeFileSync(join(t.proj, "test", "b.test.js"), "test('one', () => {});\ntest('two', () => {});\n");
  t.sh("git", "add", ".");
  t.sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "tests");
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const prompt = readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.prompt.md"), "utf8");
  assert.match(prompt, /Changed files that no DEV item names: src\.txt\./);
  assert.match(prompt, /Ticked DEV items that name no files: DEV-002\./);
  assert.match(prompt, /Lines deleted from test files: test\/b\.test\.js \(2\)/);
  assert.match(prompt, /Skip markers added: test\/b\.test\.js: test\.skip\('one', \(\) => \{\}\);/);
});

test("the tick command runs its argv without a shell", () => {
  const t = setup({ "dev-stark-1": { tickArgs: ["node", "-e", "console.log(process.argv[1]); process.exit(process.argv[1] === 'login flow' ? 0 : 1)", "login flow"] } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const ledger = readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.ticks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(ledger.map((e) => [e.item, e.lastLine]), [["DEV-001", "login flow"], ["DEV-002", "login flow"]]);
  assert.match(ledger[0].command, /'login flow'$/);

  // "|| true" is just more arguments to false, so the failure stands and nothing is ticked.
  const u = setup({ "dev-stark-1": { tickArgs: ["false", "||", "true"] } });
  u.denken("start", u.run);
  u.drive();
  const gaps = JSON.parse(readFileSync(join(u.proj, u.run, "calls", "dev-stark-1.gaps.json"), "utf8")).findings;
  assert.deepEqual(gaps.map((g) => g.identity), ["DEV-001", "DEV-002"]);
});

test("QA failures become a recovery TODO; unticked FIX items go back to STARK; cycles repeat until QA passes", () => {
  const fail = (id) => ({ qa: { result: "FAIL", items: [qaItem(1), qaItem(2, "FAIL", { check: `check 2 attempt ${id}` })] } });
  const t = setup({ "qa-genau-1": fail(1), "dev-stark-2": { fixTick: false }, "qa-genau-2": fail(2) });
  t.denken("start", t.run);
  // The same failure twice in a row: the engine cannot find the root cause, so DENKEN is called in.
  const ruling = t.drive();
  assert.equal(ruling.reason, "qa_repeated_failure");
  assert.deepEqual(ruling.identities, ["REQ-002"]);
  t.denken("rule", t.run, "--decision", "uphold", "--note", "Keep going: the recovery item names the real cause.");
  assert.equal(t.drive().action, "done");
  const calls = t.calls();
  assert.deepEqual(calls.slice(calls.indexOf("claude qa-genau-1 rw")), [
    "claude qa-genau-1 rw",
    "codex dev-stark-2 rw", // left FIX-001 unticked: straight back to STARK
    "codex dev-stark-3 rw",
    "claude dev-ubel-3 ro",
    "claude qa-genau-2 rw", // failed again: a second recovery cycle
    "codex dev-stark-4 rw",
    "claude dev-ubel-4 ro",
    "claude qa-genau-3 rw",
    "claude wiki-serie-1 rw",
    "codex wiki-frieren-1 ro",
  ]);
  const fix = readFileSync(join(t.proj, t.run, "todo-fix.md"), "utf8");
  assert.match(fix, /## QA cycle 1\n\n- \[x\] FIX-001 \(QA-002, REQ-002\) Fix: check 2 attempt 1/);
  assert.match(fix, /## QA cycle 2\n\n- \[x\] FIX-002 \(QA-002, REQ-002\) Fix: check 2 attempt 2/);
  assert.deepEqual(Object.keys(t.state().fixCycles), ["1", "2"]);
});

test("the wiki stage is told what changed in this run and which docs mention it", () => {
  const t = setup();
  mkdirSync(join(t.proj, "docs"));
  writeFileSync(join(t.proj, "docs", "guide.md"), "# Guide\n\nThe `src.txt` file holds the source.\n");
  writeFileSync(join(t.proj, "docs", "other.md"), "# Other\n\nUnrelated.\n");
  t.sh("git", "add", ".");
  t.sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "docs");
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const serie = readFileSync(join(t.proj, t.run, "calls", "wiki-serie-1.prompt.md"), "utf8");
  assert.match(serie, /Files changed in this run: src\.txt\./);
  assert.match(serie, /Existing docs that mention them: docs\/guide\.md \(src\.txt\)\./);
  assert.doesNotMatch(serie, /docs\/other\.md/);
  const frieren = readFileSync(join(t.proj, t.run, "calls", "wiki-frieren-1.prompt.md"), "utf8");
  assert.match(frieren, /Code changed in this run: src\.txt\./);
  assert.match(frieren, /Docs changed in this stage: docs\.md\./);
});

test("a wiki worker that changes a file that is not documentation goes straight back", () => {
  const t = setup({ "wiki-serie-1": { editFiles: { "lib/x.js": "export const x = 1;\n" } }, "wiki-serie-2": { removeFiles: ["lib/x.js"] } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const calls = t.calls();
  assert.deepEqual(calls.slice(calls.indexOf("claude wiki-serie-1 rw")), ["claude wiki-serie-1 rw", "claude wiki-serie-2 rw", "codex wiki-frieren-2 ro"]);
  const gaps = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "wiki-serie-1.gaps.json"), "utf8")).findings;
  assert.deepEqual(gaps.map((g) => g.identity), ["wiki-nondoc-lib/x.js"]);
});

test("a worker that lacks a permission asks DENKEN; a grant re-runs the call with it", () => {
  const t = setup({ "plan-methode-1": [{ requestPermission: { need: "network", why: "read the upstream API docs" } }, {}] });
  t.denken("start", t.run);
  const ask = t.drive();
  assert.equal(ask.action, "needs_permission");
  assert.equal(ask.role, "methode");
  assert.deepEqual(ask.requests.map((r) => r.need), ["network"]);
  assert.equal(t.denken("retry", t.run).status, 1);
  assert.equal(t.denken("grant", t.run, "--network").status, 1);
  assert.match(t.denken("grant", t.run, "--network", "--note", "x").json.error, /--user-said/);
  const granted = t.denken("grant", t.run, "--network", "--user-said", "Yes, it may use the network.", "--note", "Docs are public; read-only access is fine.").json;
  assert.equal(granted.action, "granted");
  assert.equal(t.drive().action, "done");
  assert.deepEqual(t.callsFull().filter((c) => c.includes("plan-methode-1")), ["claude plan-methode-1 rw nonet", "claude plan-methode-1 rw net"]);
  assert.match(readFileSync(join(t.proj, t.run, "rulings.md"), "utf8"), /## P1 · permission · METHODE · granted network/);
  // The grant belongs to the role that asked; reviewers never get one.
  assert.equal(JSON.parse(readFileSync(join(t.proj, t.run, "calls", "plan-richter-1.job.json"), "utf8")).agent.grants, null);
});

test("a denied permission re-runs the call with the reason; a directory grant reaches the CLI", () => {
  const cache = mkdtempSync(join(tmpdir(), "denken-cache-"));
  const t = setup({ "dev-stark-1": [{ requestPermission: { need: "dir:/opt/shared", why: "write a cache" } }, { requestPermission: { need: `dir:${cache}`, why: "npm cache" } }, {}] });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "needs_permission");
  assert.equal(t.denken("deny", t.run, "--note", "No writes outside the project; keep the cache inside it.").json.action, "denied");
  assert.equal(t.drive().action, "needs_permission");
  assert.match(t.denken("grant", t.run, "--tool", "Bash(npm *)", "--note", "x").json.error, /Claude only/);
  assert.match(t.denken("grant", t.run, "--dir", join(tmpdir(), "no-such-dir-denken"), "--note", "x").json.error, /does not exist/);
  assert.match(t.denken("grant", t.run, "--dir", cache, "--note", "x").json.error, /outside the project/);
  assert.match(t.denken("grant", t.run, "--dir", "/", "--user-said", "ok", "--note", "x").json.error, /root or home/);
  t.denken("grant", t.run, "--dir", cache, "--user-said", "Fine, that cache directory only.", "--note", "A throwaway cache directory.");
  assert.equal(t.drive().action, "done");
  const job = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.job.json"), "utf8"));
  assert.deepEqual(job.agent.grants, { network: false, domains: [], dirs: [realpathSync(cache)], tools: [] });
  assert.deepEqual(t.argsOf("dev-stark-1", 3).slice(t.argsOf("dev-stark-1", 3).indexOf("--add-dir"), t.argsOf("dev-stark-1", 3).indexOf("--add-dir") + 2), ["--add-dir", realpathSync(cache)]);
  assert.equal(job.attempt, 3);
  const rulings = readFileSync(join(t.proj, t.run, "rulings.md"), "utf8");
  assert.match(rulings, /## P1 · permission · STARK · denied dir:\/opt\/shared\n\nNo writes outside the project/);
  assert.match(rulings, /## P2 · permission · STARK · granted dir [^\n]*denken-cache-/);
});

test("every run leaves an ai-log record: request, per-step files, QA evidence, raw exchanges and a timeline", () => {
  const t = setup({ "plan-richter-1": changes(finding("scope", { file: "todo-dev.md" })) });
  writeFileSync(join(t.proj, t.run, "conversation.md"), "**User:** Build it.\n**DENKEN:** Which cases?\n**User:** Two.\n");
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const log = join(t.proj, t.state().log);
  assert.match(t.state().log, /^ai-log\/\d{8}\/001_\d{6}_test-task$/);
  const ls = (d) => readdirSync(join(log, d)).sort();
  assert.deepEqual(ls("."), ["00-request", "01-planning", "02-development", "03-qa", "04-wiki", "raw", "timeline.md", "verdicts.md"]);
  // DENKEN's request.md, as confirmed; the conversation it came from is kept raw.
  assert.equal(readFileSync(join(log, "00-request", "request.md"), "utf8"), REQUEST);
  assert.match(readFileSync(join(log, "raw", "000_conversation.md"), "utf8"), /Which cases\?/);
  assert.deepEqual(ls("01-planning"), ["01_methode-round1.md", "02_richter-rejected-round1.md", "03_methode-round2.md", "04_richter-approved-round2.md", "05_user-confirmed.md"]);
  assert.match(readFileSync(join(log, "01-planning", "02_richter-rejected-round1.md"), "utf8"), /Verdict: \*\*REJECTED\*\*[\s\S]*\[scope\] todo-dev\.md:1: scope problem\n   Required change: fix scope[\s\S]*What was checked/);
  assert.deepEqual(ls("02-development"), ["01_stark-round1.md", "02_ubel-approved-round1.md"]);
  assert.match(readFileSync(join(log, "02-development", "01_stark-round1.md"), "utf8"), /- DEV-001: `echo ok` exit 0/);
  assert.deepEqual(ls("03-qa/qa-1"), ["evidence", "report.md"]);
  assert.deepEqual(ls("03-qa/qa-1/evidence"), ["QA-001.txt", "QA-002.txt"]);
  assert.match(readFileSync(join(log, "03-qa", "qa-1", "report.md"), "utf8"), /\| QA-002 \| REQ-002 \| PASS \|[^\n]*`QA-002\.txt` \|/);
  assert.deepEqual(ls("04-wiki"), ["01_serie-round1.md", "02_frieren-approved-round1.md"]);
  // Every call's exchange, in order.
  const raw = ls("raw");
  assert.ok(raw.includes("001_plan-methode-1.prompt.md"));
  assert.ok(raw.some((f) => /^\d{3}_wiki-frieren-1\.out\.json$/.test(f)));
  const timeline = readFileSync(join(log, "timeline.md"), "utf8");
  for (const step of ["DENKEN** · run created", "METHODE (claude)** · started plan round 1", "RICHTER** · REJECTED (1 blocking)", "STOP** · confirm_todos", "USER via DENKEN** · confirmed", "RESUME** · development starts", "GENAU** · PASSED QA cycle 1", "ENGINE** · DONE: every stage approved"]) {
    assert.ok(timeline.includes(step), `timeline is missing: ${step}`);
  }  // Every submission and verdict exchanged, in order, in the words it was given.
  const verdicts = readFileSync(join(log, "verdicts.md"), "utf8").split("\n").filter((l) => l.startsWith("- "));
  const T = "\\d{2}:\\d{2}:\\d{2}";
  const expected = [
    `^- ${T} · Planning, round 1 · METHODE \\(claude\\) · plan-methode-1 · \\*\\*READY\\*\\* · methode wrote .* → 01-planning/01_methode-round1\\.md$`,
    `^- ${T} · Planning review, round 1 · RICHTER \\(codex\\) · plan-richter-1 · \\*\\*REJECTED\\*\\* · rejected: scope → 01-planning/02_richter-rejected-round1\\.md$`,
    `^- ${T} · Planning, round 2 · METHODE \\(claude\\) · plan-methode-2 · \\*\\*READY\\*\\* · .* → 01-planning/03_methode-round2\\.md$`,
    `^- ${T} · Planning review, round 2 · RICHTER \\(codex\\) · plan-richter-2 · \\*\\*APPROVED\\*\\* · richter found nothing to change → 01-planning/04_richter-approved-round2\\.md$`,
    `^- ${T} · Confirmation · USER · \\*\\*CONFIRMED\\*\\* · Looks good, go ahead\\. → 01-planning/05_user-confirmed\\.md$`,
    `^- ${T} · Development, round 1 · STARK \\(codex\\) · dev-stark-1 · \\*\\*READY\\*\\* · .* → 02-development/01_stark-round1\\.md$`,
    `^- ${T} · Development review, round 1 · UBEL \\(claude\\) · dev-ubel-1 · \\*\\*APPROVED\\*\\* · ubel found nothing to change → 02-development/02_ubel-approved-round1\\.md$`,
    `^- ${T} · Independent QA, cycle 1 · GENAU \\(claude\\) · qa-genau-1 · \\*\\*PASSED\\*\\* · every check passed on the running product → 03-qa/qa-1/report\\.md$`,
    `^- ${T} · Docs, round 1 · SERIE \\(claude\\) · wiki-serie-1 · \\*\\*READY\\*\\* · .* → 04-wiki/01_serie-round1\\.md$`,
    `^- ${T} · Docs review, round 1 · FRIEREN \\(codex\\) · wiki-frieren-1 · \\*\\*APPROVED\\*\\* · frieren found nothing to change → 04-wiki/02_frieren-approved-round1\\.md$`,
    `^- ${T} · Done · ENGINE · \\*\\*DONE\\*\\* · every stage approved$`,
  ];
  assert.equal(verdicts.length, expected.length, verdicts.join("\n"));
  expected.forEach((re, i) => assert.match(verdicts[i], new RegExp(re)));
  // Every file a verdict links to exists, and the finished file's digest is in the timeline.
  for (const v of verdicts) for (const [, f] of v.matchAll(/→ (\S+)$/g)) assert.ok(existsSync(join(log, f)), f);
  assert.ok(timeline.includes(`verdicts.md sha256: ${t.state().verdictsSha}`));
});

test("verdicts.md is written by the engine alone: a copy changed between calls is kept and replaced", () => {
  const t = setup({ "plan-richter-1": changes(finding("scope", { file: "todo-dev.md" })) });
  t.denken("start", t.run);
  assert.equal(t.drive({ autoConfirm: false }).reason, "confirm_todos");
  const path = join(t.proj, t.state().log, "verdicts.md");
  const original = readFileSync(path, "utf8");
  // Someone deletes the rejection before the user confirms.
  writeFileSync(path, original.split("\n").filter((l) => !l.includes("REJECTED")).join("\n"));
  t.denken("confirm", t.run, "--user-said", "Looks good, go ahead.");
  const now = readFileSync(path, "utf8");
  assert.ok(now.startsWith(original));
  assert.match(now, /\*\*RESTORED\*\* · verdicts\.md was changed outside the engine[^\n]* → raw\/verdicts\.changed-\d{14}\.md\n[^\n]*\*\*CONFIRMED\*\*/);
  const kept = now.match(/→ (raw\/verdicts\.changed-\d{14}\.md)/)[1];
  assert.doesNotMatch(readFileSync(join(t.proj, t.state().log, kept), "utf8"), /REJECTED/);
});

test("when the reviewer's own verdict and the stage's outcome differ, the record says both", () => {
  const nit = { ...finding("style"), severity: "nonblocking" };
  const t = setup({ "dev-ubel-1": { review: { verdict: "CHANGES_REQUESTED", summary: "Only style nits remain.", findings: [nit], checked: [] } } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const verdicts = readFileSync(join(t.proj, t.state().log, "verdicts.md"), "utf8");
  assert.match(verdicts, /· Development review, round 1 · UBEL \(claude\) · dev-ubel-1 · \*\*APPROVED\*\* \(reviewer's verdict: REJECTED; 0 open blocking finding\(s\)\) · Only style nits remain\./);
  assert.match(readFileSync(join(t.proj, t.state().log, "02-development", "02_ubel-approved-round1.md"), "utf8"), /Verdict: \*\*APPROVED\*\* \(reviewer's verdict: REJECTED/);
});

test("request ids are never reused: once confirmed, a changed item needs a new id", () => {
  const t = setup();
  t.denken("start", t.run);
  t.drive({ autoConfirm: false });
  t.denken("confirm", t.run, "--user-said", "Approved.");
  const request = join(t.proj, t.run, "request.md");
  const original = readFileSync(request, "utf8");
  writeFileSync(request, original.replace("- REQ-002. Two. Done when: two works.", "- REQ-002. Two, faster. Done when: two works in 1s."));
  assert.equal(t.drive({ autoConfirm: false }).reason, "scope_changed");
  assert.match(t.denken("rule", t.run, "--decision", "replan", "--note", "Faster.").json.error, /REQ-002 now reads differently from what the user confirmed\. Ids are never reused/);
  writeFileSync(request, original.replace("- REQ-002. Two. Done when: two works.", "- REQ-003. Two, faster. Done when: two works in 1s."));
  assert.equal(t.denken("rule", t.run, "--decision", "replan", "--note", "REQ-002 is replaced by REQ-003.").json.action, "ruled");
});

test("the timeline records a QA failure, the recovery round, a permission stop and DENKEN's decision", () => {
  const t = setup({ "qa-genau-1": { qa: { result: "FAIL", items: [qaItem(1), qaItem(2, "FAIL")] } }, "dev-stark-2": [{ requestPermission: { need: "network", why: "fetch a fixture" } }, {}] });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "needs_permission");
  t.denken("grant", t.run, "--network", "--user-said", "OK.", "--note", "The fixture host is trusted.");
  assert.equal(t.drive().action, "done");
  const log = join(t.proj, t.state().log);
  const timeline = readFileSync(join(log, "timeline.md"), "utf8");
  const order = ["GENAU** · FAILED QA cycle 1: QA-002", "ENGINE** · recovery TODO FIX-001", "STARK** · asked for permission: network (fetch a fixture)", "STOP** · needs_permission", "DENKEN** · granted network (all hosts) to STARK", "RESUME** · dev-stark-2 runs again", "GENAU** · PASSED QA cycle 2"];
  let at = 0;
  for (const step of order) {
    const i = timeline.indexOf(step, at);
    assert.ok(i >= at, `timeline out of order or missing: ${step}`);
    at = i;
  }
  const dev = readdirSync(join(log, "02-development"));
  assert.ok(dev.some((f) => /_engine-recovery-todo-qa1\.md$/.test(f)));
  assert.ok(dev.some((f) => /_denken-permission-P1-grant\.md$/.test(f)));
  assert.deepEqual(readdirSync(join(log, "03-qa")).sort(), ["qa-1", "qa-2"]);
});
