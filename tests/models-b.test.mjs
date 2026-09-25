// DENKEN engine tests: models-b. Shared setup is in helpers.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changes, FAKE, finding, qaItem, REQUEST, SCRIPTS, setup, TWO_UNITS } from "./helpers.mjs";

test("levels: the separation holds by model, not by name, and by what actually ran", () => {
  // One provider: "opus" and "claude-opus-5-5" name the same model, so this is refused.
  const one = { providers: ["claude"], roles: { richter: { effort: "high" }, frieren: { effort: "high" }, genau: { model: "haiku" }, stark: { model: "opus" }, ubel: { model: "claude-opus-5-5" } } };
  const t = setup({}, one);
  assert.equal(t.denken("start", t.run).json.reason, "same_reviewer");
  // Asked for different models, but both ran as the same one (an alias, an allowlist): the check is not used.
  const u = setup({ "dev-stark-1": { modelRan: "claude-opus-5-5" }, "dev-ubel-1": { modelRan: "claude-opus-5-5" } }, { ...one, roles: { ...one.roles, ubel: { model: "sonnet" } } });
  assert.equal(u.denken("start", u.run).json.action, "started");
  const r = u.drive();
  assert.equal(r.reason, "same_model_ran");
  assert.equal(r.checked, "dev-stark-1");
  assert.match(readFileSync(join(u.proj, u.state().log, "timeline.md"), "utf8"), /UBEL ran as claude-opus-5-5, the same model and effort as the work it checks \(dev-stark-1\); its result is not used/);
  assert.match(r.next, /levels <run> ubel=<level>/);
  // Retrying the same assignment would only block again, so it waits for a change.
  assert.match(u.denken("retry", u.run).json.error, /ubel would run the same way again/);
  assert.equal(u.denken("levels", u.run, "ubel=heavy", "--note", "Check with a stronger effort than the work.").json.action, "levels");
  assert.equal(u.denken("retry", u.run).json.action, "resumed");
  assert.equal(u.drive().action, "done");
});

test("FLAMME: a worker seed, a reviewer seed and a QA seed; every call forks its kind's seed with the same flags", () => {
  const t = setup({ "plan-richter-1": changes(finding("scope", { file: "todo-dev.md" })) }, { seeds: { claude: true } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const calls = t.calls();
  // Claude's seeds: the workers' (made again once there is a confirmed development TODO), the reviewers' and QA's.
  assert.deepEqual(calls.filter((c) => c.includes("flamme")), ["claude plan-flamme-worker rw", "claude dev-flamme-reviewer ro", "claude qa-flamme-qa rw", "claude wiki-flamme-worker rw"]);
  assert.equal(calls[calls.indexOf("claude plan-flamme-worker rw") + 1], "claude plan-methode-1 rw");
  assert.ok(!calls.some((c) => c.startsWith("codex") && c.includes("flamme")));
  // Both of METHODE's rounds fork the same seed, with exactly the seed's flags.
  const seedArgs = t.argsOf("plan-flamme-worker");
  const seedId = seedArgs[seedArgs.indexOf("--session-id") + 1];
  const shape = (args) => args.filter((a, i) => !["--session-id", "--resume"].includes(args[i - 1]) && !["--resume", "--fork-session"].includes(a));
  // METHODE's first round forks the seed; its second continues its own first session.
  const m1 = t.argsOf("plan-methode-1");
  const m2 = t.argsOf("plan-methode-2");
  assert.equal(m1[m1.indexOf("--resume") + 1], seedId);
  assert.equal(m2[m2.indexOf("--resume") + 1], m1[m1.indexOf("--session-id") + 1]);
  for (const args of [m1, m2]) {
    assert.ok(args.includes("--fork-session"));
    assert.deepEqual(shape(args), shape(seedArgs));
    assert.ok(!args.includes("--append-system-prompt-file"));
    assert.ok(args.includes("--exclude-dynamic-system-prompt-sections"));
  }
  assert.ok(readFileSync(join(t.proj, t.run, "calls", "plan-methode-2.prompt.md"), "utf8").startsWith("## This call"));
  // A fork's role is in its message, since the forked session keeps the seed's system prompt.
  assert.ok(readFileSync(join(t.proj, t.run, "calls", "plan-methode-1.prompt.md"), "utf8").startsWith("# METHODE:"));
  // A worker seed never holds the request (STARK sees only the development TODO); the reviewer seed does.
  const seedPrompt = (call) => readFileSync(join(t.proj, t.run, "calls", `${call}.seed.prompt.md`), "utf8");
  assert.match(seedPrompt("plan-methode-1"), /- Seed for: worker\. Used by the workers who plan, build and document \(METHODE, STARK, SERIE\)\.\n[\s\S]*- Read: nothing from the run yet; the project itself\n/);
  assert.match(seedPrompt("wiki-serie-1"), /- Seed for: worker\.[\s\S]*- Read:\n {2}- \S+todo-dev\.md\n/);
  assert.doesNotMatch(seedPrompt("wiki-serie-1"), /request\.md/);
  assert.match(seedPrompt("dev-ubel-1"), /- Seed for: reviewer\.[\s\S]*- Read:\n {2}- \S+request\.md\n- This call answers in JSON/);
  // METHODE gets the request in its own message.
  assert.match(readFileSync(join(t.proj, t.run, "calls", "plan-methode-1.prompt.md"), "utf8"), /- Read:\n {2}- \S+request\.md/);
  // No hook of anyone's interactive sessions runs in a DENKEN call.
  for (const key of ["plan-flamme-worker", "plan-methode-1", "dev-ubel-1", "qa-genau-1"]) {
    const args = t.argsOf(key);
    assert.equal(JSON.parse(args[args.indexOf("--settings") + 1]).disableAllHooks, true, key);
  }
  assert.equal(Object.keys(t.state().seedSessions).length, 4);
  assert.match(readFileSync(join(t.proj, t.state().log, "timeline.md"), "utf8"), /\*\*FLAMME \(claude\)\*\* · seeded the worker context in the plan stage, for plan-methode-1 \(in 100 · cache read 300 · out 10\); calls with the same perspective and settings fork it/);
  assert.match(readFileSync(join(t.proj, t.state().log, "01-planning", "01_methode-round1.md"), "utf8"), new RegExp(`- Seed: forked from FLAMME's seed ${seedId}, made for this call\\n`));
  assert.match(readFileSync(join(t.proj, t.state().log, "01-planning", "03_methode-round2.md"), "utf8"), /- Session: continued the session of plan-methode-1 \(round 2 in it\)\n/);
  assert.equal(t.denken("status", t.run).json.tokens.flamme.calls, 4);
});

test("FLAMME on Codex: forks always set their own sandbox, and a worker's seed never holds the request", () => {
  const t = setup({}, { seeds: { claude: false, codex: true } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const stark = t.argsOf("dev-stark-1");
  assert.deepEqual(stark.slice(0, 3), ["exec", "fork", "thread-dev-flamme-worker"]);
  assert.ok(stark.includes('sandbox_mode="workspace-write"') && !stark.includes("-s"));
  const richter = t.argsOf("plan-richter-1");
  assert.deepEqual(richter.slice(0, 3), ["exec", "fork", "thread-plan-flamme-reviewer"]);
  assert.ok(richter.includes('sandbox_mode="read-only"'));
  // FRIEREN, a reviewer with the same settings, forks the same reviewer seed.
  assert.deepEqual(t.argsOf("wiki-frieren-1").slice(0, 3), ["exec", "fork", "thread-plan-flamme-reviewer"]);
  // The seed itself only reads.
  assert.ok(t.argsOf("dev-flamme-worker").join(" ").includes("-s read-only"));
  const starkSeed = readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.seed.prompt.md"), "utf8");
  assert.match(starkSeed, /- Read:\n {2}- \S+todo-dev\.md\n/);
  assert.doesNotMatch(starkSeed, /request\.md/);
});

test("FLAMME: a fork that cannot start runs from scratch; a seed that changes files is a violation; --seeds off turns seeding off", () => {
  const t = setup({ "dev-ubel-1": [{ fail: "No conversation found with session ID" }, {}] }, { seeds: { claude: true } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.match(readFileSync(join(t.proj, t.state().log, "timeline.md"), "utf8"), /\*\*ENGINE\*\* · UBEL ran without FLAMME's seed: the fork of \S+ failed/);
  assert.ok(!Object.values(t.state().seedSessions).some((s) => s.perspective === "reviewer"));
  assert.ok(!t.argsOf("dev-ubel-1", 2).includes("--resume"));

  const u = setup({ "plan-flamme-worker": { touch: "a.txt" } }, { seeds: { claude: true } });
  u.denken("start", u.run);
  const r = u.drive();
  assert.equal(r.reason, "guard_violation");
  assert.match(r.violations.join("\n"), /FLAMME's seed: project files changed/);

  const v = setup({}, { seeds: { claude: true } });
  v.denken("start", v.run, "--seeds", "off");
  assert.equal(v.drive().action, "done");
  assert.ok(!v.calls().some((c) => c.includes("flamme")));
});

test("FLAMME: a checker's seed ends with a placeholder, not a verdict; a seed idle for an hour is re-warmed before a fork", () => {
  const t = setup({
    "qa-genau-1": { qa: { result: "FAIL", summary: "two fails", items: [qaItem(1), qaItem(2, "FAIL")] } },
    "dev-stark-2": [{ requestPermission: { need: "network", why: "fetch a fixture" } }, {}],
  }, { seeds: { claude: true } });
  t.denken("start", t.run);
  // The seed's answer uses the schema's placeholder, and the fork is told it is not a result.
  assert.equal(t.drive().reason, "needs_permission");
  const ubelSeed = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.seed.out.md"), "utf8"));
  assert.equal(ubelSeed.verdict, "CONTEXT_LOADED");
  assert.match(readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.prompt.md"), "utf8"), /FLAMME's JSON at the end of it \(CONTEXT_LOADED\) only marked the context as loaded; it is not a result/);
  // An hour passes while DENKEN decides.
  const path = join(t.proj, t.run, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const before = Object.values(state.seedSessions).find((x) => x.perspective === "reviewer").sessionId;
  for (const x of Object.values(state.seedSessions)) x.lastUsedAt = new Date(Date.now() - 2 * 3600000).toISOString();
  writeFileSync(path, JSON.stringify(state));
  t.denken("grant", t.run, "--network", "--user-said", "Fine.", "--note", "Fixture download.");
  assert.equal(t.drive().action, "done");
  const calls = t.calls();
  assert.equal(calls[calls.indexOf("claude dev-ubel-2 ro") - 1], "claude rewarm");
  const after = Object.values(t.state().seedSessions).find((x) => x.perspective === "reviewer").sessionId;
  assert.notEqual(after, before);
  const ubel2 = t.argsOf("dev-ubel-2");
  assert.equal(ubel2[ubel2.indexOf("--resume") + 1], after);
  assert.match(readFileSync(join(t.proj, t.state().log, "timeline.md"), "utf8"), /FLAMME \(claude\)\*\* · re-warmed the reviewer seed, idle for close to an hour, before dev-ubel-2 forked it/);
  // Seeded Claude calls keep their cache for an hour.
  assert.equal(JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-ubel-2.job.json"), "utf8")).seed.rewarm, true);
});

test("a worker's later rounds continue its own session, up to three rounds; checkers always start fresh", () => {
  const t = setup({ "dev-ubel-1": changes(finding("a")), "dev-ubel-2": changes(finding("b")), "dev-ubel-3": changes(finding("c")) }, { limits: { roundsPerStage: 6 } });
  t.denken("start", t.run);
  for (let r = t.drive(); r.action !== "done"; r = t.drive()) {
    assert.equal(r.action, "needs_ruling", JSON.stringify(r));
    t.denken("rule", t.run, "--decision", "uphold", "--note", "Keep going.");
  }
  // Codex continues STARK's thread in place, with the sandbox set explicitly.
  const s2 = t.argsOf("dev-stark-2");
  assert.deepEqual(s2.slice(0, 3), ["exec", "resume", "thread-dev-stark-1"]);
  assert.ok(s2.includes('sandbox_mode="workspace-write"') && !s2.includes("-s"));
  assert.deepEqual(t.argsOf("dev-stark-3").slice(0, 3), ["exec", "resume", "thread-dev-stark-1"]);
  // A session serves three rounds; the fourth starts clean.
  assert.deepEqual(t.argsOf("dev-stark-4").slice(0, 2), ["exec", "--json"]);
  // Its message holds only this call: the role and the earlier rounds are in the session.
  const p2 = readFileSync(join(t.proj, t.run, "calls", "dev-stark-2.prompt.md"), "utf8");
  assert.ok(p2.startsWith("## This call\n\n- Role: STARK"));
  assert.match(p2, /You continue your own session from dev-stark-1/);
  assert.doesNotMatch(readFileSync(join(t.proj, t.run, "calls", "dev-stark-4.prompt.md"), "utf8"), /You continue your own session/);
  // Reviewers never continue.
  for (const n of [1, 2, 3, 4]) assert.ok(!t.argsOf(`dev-ubel-${n}`).includes("--resume"), `dev-ubel-${n}`);
  assert.match(readFileSync(join(t.proj, t.state().log, "timeline.md"), "utf8"), /STARK \(codex\)\*\* · started dev round 2, continuing its session from dev-stark-1/);
  assert.match(readFileSync(join(t.proj, t.state().log, "02-development", "03_stark-round2.md"), "utf8"), /- Session: continued the session of dev-stark-1 \(round 2 in it\)/);
});

test("a worker whose session cannot be continued starts fresh", () => {
  const t = setup({ "dev-ubel-1": changes(finding("a")), "dev-stark-2": [{ fail: "no session with that id" }, {}] });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.deepEqual(t.argsOf("dev-stark-2", 1).slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(t.argsOf("dev-stark-2", 2).slice(0, 2), ["exec", "--json"]);
  assert.match(readFileSync(join(t.proj, t.state().log, "timeline.md"), "utf8"), /ENGINE\*\* · STARK could not continue its session, and started fresh: continuing thread-dev-stark-1 failed/);
});

test("a continued worker is told what changed since its last call; after a second QA failure, or an hour idle, it starts fresh", () => {
  const fail = (n) => ({ qa: { result: "FAIL", summary: "fails", items: [qaItem(1), qaItem(2, "FAIL", { check: `check 2 attempt ${n}` })] } });
  const t = setup({ "qa-genau-1": fail(1), "qa-genau-2": fail(2) });
  t.denken("start", t.run);
  for (let r = t.drive(); r.action !== "done"; r = t.drive()) t.denken("rule", t.run, "--decision", "uphold", "--note", "Keep going.");
  // The first fix round continues STARK's session, and is told what the engine did meanwhile.
  assert.deepEqual(t.argsOf("dev-stark-2").slice(0, 3), ["exec", "resume", "thread-dev-stark-1"]);
  const p2 = readFileSync(join(t.proj, t.run, "calls", "dev-stark-2.prompt.md"), "utf8");
  assert.match(p2, /Since then:\n {2}- the engine unticked DEV-002 \(after QA cycle 1\): QA failed for the request items they serve\n {2}- QA cycle 1 failed; the engine wrote FIX-001 to todo-fix\.md\n {2}- the engine wrote the ticks you recorded/);
  // QA failed again: STARK starts clean rather than defend its work.
  assert.deepEqual(t.argsOf("dev-stark-3").slice(0, 2), ["exec", "--json"]);

  // A session idle for about an hour is not continued: its cache would have expired.
  const u = setup({ "dev-ubel-1": changes(finding("a")), "dev-stark-2": [{ requestPermission: { need: "network", why: "a fixture" } }, {}] });
  u.denken("start", u.run);
  assert.equal(u.drive().reason, "needs_permission");
  const path = join(u.proj, u.run, "state.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.workSessions.stark.at = new Date(Date.now() - 2 * 3600000).toISOString();
  writeFileSync(path, JSON.stringify(state));
  u.denken("grant", u.run, "--network", "--user-said", "Fine.", "--note", "Fixture.");
  assert.equal(u.drive().action, "done");
  assert.deepEqual(u.argsOf("dev-stark-2", 1).slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(u.argsOf("dev-stark-2", 2).slice(0, 2), ["exec", "--json"]);
});
