// DENKEN engine tests: models-a. Shared setup is in helpers.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changes, FAKE, finding, qaItem, REQUEST, SCRIPTS, setup, TWO_UNITS } from "./helpers.mjs";

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

test("an inherited GIT_DIR (as in a git hook) does not point the tests or the engine at another repository", () => {
  const outer = mkdtempSync(join(tmpdir(), "denken-outer-"));
  spawnSync("git", ["init", "-q"], { cwd: outer });
  const before = readFileSync(join(outer, ".git", "config"), "utf8");
  const objects = () => readdirSync(join(outer, ".git", "objects")).filter((d) => /^[0-9a-f]{2}$/.test(d)).length;
  // The test harness drops it...
  process.env.GIT_DIR = join(outer, ".git");
  let t;
  try {
    t = setup();
  } finally {
    delete process.env.GIT_DIR;
  }
  // ...and so does the engine, when it is handed one directly.
  const engine = (...args) => JSON.parse(spawnSync(process.execPath, [join(SCRIPTS, "denken.mjs"), ...args], { cwd: t.proj, env: { ...t.env, GIT_DIR: join(outer, ".git") }, encoding: "utf8" }).stdout);
  assert.equal(engine("start", t.run).action, "started");
  let r;
  for (let i = 0; i < 20 && r?.action !== "done"; i++) {
    r = engine("next", t.run, "--wait", "60");
    if (r.reason === "confirm_todos") engine("confirm", t.run, "--user-said", "Go.");
  }
  assert.equal(r.action, "done");
  assert.equal(readFileSync(join(outer, ".git", "config"), "utf8"), before);
  assert.equal(objects(), 0);
});

test("levels: DENKEN picks a level per stage; workers can go light, checkers never below standard or their worker", () => {
  const t = setup();
  const started = t.denken("start", t.run, "--level", "plan=light", "--level", "dev=heavy", "--level", "wiki=light").json;
  assert.equal(started.action, "started");
  const level = (r) => [started.roles[r].model, started.roles[r].effort, started.roles[r].level];
  assert.deepEqual(level("methode"), ["sonnet", "low", "light"]); // claude light
  assert.deepEqual(level("richter"), [null, null, "standard"]); // its checker stays at standard
  assert.deepEqual(level("stark"), [null, "high", "heavy"]); // codex heavy: effort only
  assert.deepEqual(level("ubel"), ["opus", "high", "heavy"]); // claude heavy, as heavy as the work it checks
  assert.deepEqual(level("genau"), ["opus", "high", "heavy"]); // GENAU checks STARK's work too
  assert.deepEqual(level("serie"), ["sonnet", "low", "light"]);
  assert.equal(t.drive().action, "done");
  const args = (key) => t.argsOf(key).join(" ");
  assert.match(args("plan-methode-1"), /--model sonnet --effort low/);
  assert.match(args("dev-stark-1"), /model_reasoning_effort="high"/);
  assert.match(args("dev-ubel-1"), /--model opus --effort high/);
  // The step file and the status show what ran, and how much came from the cache.
  assert.match(readFileSync(join(t.proj, t.state().log, "01-planning", "01_methode-round1.md"), "utf8"), /- Level: light\n- Model that ran: sonnet-resolved\n- Tokens: in 100 · out 10 · cache read 300 · cache write 100/);
  const status = t.denken("status", t.run).json;
  assert.equal(status.roles.methode, "claude: sonnet, low [light]");
  assert.equal(status.tokens.methode.fromCache, "60%");
});

test("levels: a checker can't be made light, and levels are checked before the run starts", () => {
  const t = setup();
  assert.match(t.denken("start", t.run, "--level", "qa=light").json.error, /qa checks other work \(genau\), and a checker never runs below standard/);
  assert.match(t.denken("start", t.run, "--level", "richter=light").json.error, /a checker never runs below standard/);
  assert.match(t.denken("start", t.run, "--level", "dev=turbo").json.error, /a level is one of light, standard, heavy/);
  assert.match(t.denken("start", t.run, "--model", "plan=opus").json.error, /--model names one role/);
  assert.match(t.denken("start", t.run, "--effort", "stark=max9").json.error, /stark runs on codex, whose effort is one of/);
  assert.equal(t.denken("start", t.run, "--model", "stark=gpt-mini", "--effort", "genau=medium").json.action, "started");
  assert.equal(t.state().overrides.stark.model, "gpt-mini");
});

test("levels: DENKEN can change them mid-run, and the change is recorded", () => {
  const naming = changes(finding("naming"));
  const t = setup({ "dev-ubel-1": naming, "dev-ubel-2": naming, "dev-ubel-3": naming });
  t.denken("start", t.run);
  assert.equal(t.drive().reason, "topic_repeated");
  assert.match(t.denken("levels", t.run, "dev=heavy").json.error, /say why/);
  const r = t.denken("levels", t.run, "dev=heavy", "--note", "The loop keeps failing on the same point; give it a stronger model.").json;
  assert.equal(r.action, "levels");
  t.denken("rule", t.run, "--decision", "dismiss", "--note", "Naming is a preference.");
  assert.equal(t.drive().action, "done");
  assert.match(t.argsOf("qa-genau-1").join(" "), /--model opus --effort high/);
  assert.match(readFileSync(join(t.proj, t.state().log, "verdicts.md"), "utf8"), /· Levels · DENKEN · \*\*SET\*\* · STARK codex → codex: high \[heavy\]; UBEL claude → claude: opus, high \[heavy\]; GENAU claude → claude: opus, high \[heavy\]: The loop keeps failing/);
});

test("levels: a unit can carry its own levels", () => {
  const t = setup();
  t.split("- UNIT-1 (REQ-001) One. Scope: `a/`. Levels: dev=heavy.\n- UNIT-2 (REQ-002) Two. Scope: `b/`.\n");
  assert.deepEqual(t.denken("start", t.run, "--level", "plan=light").json.units.map((u) => u.levels), [{ stark: "heavy", ubel: "heavy" }, {}]);
  assert.equal(t.drive().action, "done");
  assert.match(t.argsOf("UNIT-1:dev-stark-1").join(" "), /model_reasoning_effort="high"/);
  assert.doesNotMatch(t.argsOf("UNIT-2:dev-stark-1").join(" "), /model_reasoning_effort/);
  assert.match(t.argsOf("UNIT-2:plan-methode-1").join(" "), /--model sonnet --effort low/);
});
