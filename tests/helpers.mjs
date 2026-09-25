// Shared setup for the DENKEN engine tests: a project with fake claude/codex CLIs on PATH.
// The tests are split over several files so that node --test runs them in parallel.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A git hook that runs these tests (pre-push does) sets GIT_DIR and friends. Every git command the
// tests start would then act on the repository being pushed instead of a test's own.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];

const here = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS = join(here, "..", "skills", "denken", "scripts");
export const FAKE = join(here, "fake-agent.mjs");

export const REQUEST = "# Request: test\n\n## Goal\nTest.\n\n## Confirmed\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Out of scope\n- OUT-001. Three.\n\n## Not now\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n";
export const finding = (topic, extra = {}) => ({ severity: "blocking", topic, file: "src.txt", line_start: 1, line_end: 1, request_item: null, todo: null, problem: `${topic} problem`, required_change: `fix ${topic}`, ...extra });
export const qaItem = (n, result = "PASS", extra = {}) => ({ id: `QA-${String(n).padStart(3, "0")}`, request_item: `REQ-${String(n).padStart(3, "0")}`, check: `check ${n}`, how_verified: "x", result, evidence: result === "PASS" ? "ok" : "boom", reproduce: result === "PASS" ? null : "npm test", ...extra });
export const changes = (...findings) => ({ review: { verdict: "CHANGES_REQUESTED", summary: `rejected: ${findings.map((f) => f.topic).join(", ")}`, findings, checked: [] } });

export function setup(scenario = {}, config = null) {
  const dir = mkdtempSync(join(tmpdir(), "denken-test-"));
  const bin = join(dir, "bin");
  const proj = join(dir, "proj");
  mkdirSync(bin);
  mkdirSync(proj);
  chmodSync(FAKE, 0o755);
  for (const cli of ["claude", "codex"]) symlinkSync(FAKE, join(bin, cli));
  const scenarioPath = join(dir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  // Git variables inherited from a hook (a pre-push hook running these tests sets GIT_DIR) would
  // point every git command here at the repository being pushed.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const env = { ...inherited, PATH: `${bin}:${process.env.PATH}`, FAKE_SCENARIO: scenarioPath, DENKEN_SKIP_AUTH_CHECK: "1", XDG_CONFIG_HOME: join(dir, "xdg"), DENKEN_WORKTREES: join(dir, "worktrees") };
  // Seeds are off unless a test turns them on in its config: they add FLAMME's calls to every run.
  mkdirSync(join(dir, "xdg", "denken"), { recursive: true });
  writeFileSync(join(dir, "xdg", "denken", "config.json"), JSON.stringify({ seeds: { claude: false, codex: false } }));
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
  writeFileSync(join(proj, run, "request.md"), REQUEST);
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
  const argsOf = (key, attempt = 1) => readFileSync(`${scenarioPath}.args.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.key === key && e.attempt === attempt)?.args;
  const state = () => JSON.parse(readFileSync(join(proj, run, "state.json"), "utf8"));
  // Units: folders a/ and b/ in the project, and DENKEN's split in units.md.
  const split = (units) => {
    for (const d of ["a", "b"]) {
      mkdirSync(join(proj, d), { recursive: true });
      writeFileSync(join(proj, d, "keep.txt"), `${d}\n`);
    }
    sh("git", "add", ".");
    sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "folders");
    writeFileSync(join(proj, run, "units.md"), `# Units\n\n${units}`);
  };
  const worktrees = () => sh("git", "worktree", "list", "--porcelain").stdout.split("\n").filter((l) => l.startsWith("worktree ")).length;
  return { dir, proj, run, env, sh, node, denken, drive, calls, callsFull, argsOf, state, split, worktrees };
}
export const TWO_UNITS = "- UNIT-1 (REQ-001) One. Scope: `a/`.\n- UNIT-2 (REQ-002) Two. Scope: `b/`.\n";

