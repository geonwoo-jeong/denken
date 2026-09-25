#!/usr/bin/env node
// DENKEN run engine: a deterministic state machine for the stage loop.
// DENKEN (the LLM) handles intake, rulings and talking to the user. This script handles the rest:
// which call runs next, launching it as a separate agent process, guarding files, parsing
// verdicts, counting repeated topics, and every write to state.json.
//
//   node denken.mjs new <slug>                  create .denken/runs/<id>/ and print its path
//   node denken.mjs start <run>                 check request.md, snapshot the role assignment, begin plan
//   node denken.mjs confirm <run> --user-said <text>   the user approved the scope and TODO lists; begin dev
//   node denken.mjs next <run> [--wait <sec>]   advance the run; prints one JSON action
//   node denken.mjs rule <run> --decision <uphold|dismiss|replan|abort> (--note <text> | --note-file <path>)
//                   [--identities <a,b>]        which open findings a dismissal covers
//   (start, next, rule and retry take a per-run lock, so only one engine process works on a run.)
//   node denken.mjs retry <run>                 resume after a needs_user block
//   node denken.mjs status <run>                compact summary
//   node denken.mjs tick <run> DEV-001|FIX-001 (--evidence <text> | --no-change <why>) -- <cmd> <args...>
//                   STARK, during its call: check the evidence, run the item's tests, and on success
//                   record the tick; the engine writes it into the TODO file when the call ends
//   node denken.mjs request-permission <run> --need <what> --why <why>   a worker or GENAU, during its call
//   node denken.mjs grant <run> [--network] [--dir <path>]... [--tool <pattern>]... --note <text>
//   node denken.mjs deny <run> --note <text>    DENKEN's answer to a permission request; the call runs again
//   node denken.mjs secrets <run> --rescan | --accept --user-said <text>   after a secrets_in_record stop
//
// Actions printed by next: running | needs_ruling | needs_user | done | aborted.
// Run files: request.md (DENKEN) -> todo-dev.md + todo-qa.md (METHODE) -> user confirms -> dev, qa, wiki.
// Run from the project root.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_DIR = join(dirname(SCRIPT), "..");
const ROOT = process.cwd();
const DENKEN_DIR = join(ROOT, ".denken");
// DENKEN's own trees: never part of the project as far as guards, diffs and scope are concerned.
const EXCLUDE = [":(exclude).denken", ":(exclude)ai-log"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NEXT_STAGE = { plan: "dev", dev: "qa", qa: "wiki", wiki: "done" };
const WORKER = { plan: "methode", dev: "stark", wiki: "serie" };
const REVIEWER = { plan: "richter", dev: "ubel", wiki: "frieren" };
const REQUEST = "request.md";
const TODO_DEV = "todo-dev.md";
const TODO_QA = "todo-qa.md";
const TODO_FIX = "todo-fix.md";
const ARTIFACTS = { plan: [TODO_DEV, TODO_QA], dev: ["dev-report.md"], wiki: ["wiki-report.md"] };
const PERMISSION_ASKS_PER_ROLE = 5;
const PERMISSION_ATTEMPTS_PER_CALL = 3;
const USAGE_LIMIT = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/i;

// ---------- helpers

const print = (value) => console.log(JSON.stringify(value, null, 2));
function fail(message) {
  print({ action: "error", error: message });
  process.exit(1);
}
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hashFile = (path) => {
  try {
    return sha(readFileSync(path));
  } catch {
    return "missing";
  }
};
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The engine runs git outside any sandbox, so it never lets repository config run programs:
// no fsmonitor, no hooks, and no external diff drivers or textconv filters. It always works on the
// repository it runs in: GIT_DIR and the like, inherited from a git hook for example, would point
// its git commands at another repository.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES)$/.test(k)));
function git(...args) {
  const safe = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...(args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args)];
  const r = spawnSync("git", safe, { cwd: ROOT, env: GIT_ENV, maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : Buffer.alloc(0);
}
const gitText = (...args) => git(...args).toString("utf8").trim();

// Git in a given directory for the work on units (worktrees, patches, the base commit), with the
// same protections, and with every filter driver in the repository config switched off: a unit's
// agents share the repository's .git, so a driver there is not trusted to run.
function gitAt(dir, args, { env = {}, input } = {}) {
  const drivers = new Set(gitText("config", "--get-regexp", "^filter\\.").split("\n").map((l) => l.match(/^filter\.(.+)\.[^.\s]+\s/)?.[1]).filter(Boolean));
  const off = [...drivers].flatMap((d) => ["-c", `filter.${d}.clean=`, "-c", `filter.${d}.smudge=`, "-c", `filter.${d}.process=`, "-c", `filter.${d}.required=false`]);
  const safe = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...off, ...(args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args)];
  const r = spawnSync("git", safe, { cwd: dir, env: { ...GIT_ENV, ...env }, input, maxBuffer: 1 << 30 });
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0), err: (r.stderr ?? "").toString("utf8").trim() };
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// ---------- state

function runDirOf(arg) {
  if (!arg) fail("missing <run> argument");
  const dir = resolve(ROOT, arg);
  if (!existsSync(join(dir, "state.json"))) fail(`not a run directory: ${arg}`);
  return dir;
}
function load(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch (e) {
    fail(`${join(dir, "state.json")} is unreadable: ${e.message}`);
  }
}
function save(dir, state) {
  const tmp = join(dir, "state.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, join(dir, "state.json"));
}
const callBase = (dir, id) => join(dir, "calls", id);

// ---------- file guard

// Files that configure the agents, and DENKEN's own skill: a call that changed them could plant
// hooks, MCP servers or instructions that the next call (a reviewer's, say) would then load.
// They belong to DENKEN for the whole run: a change is undone and recorded.
const AGENT_CONTEXT = /(^|\/)(CLAUDE|CLAUDE\.local|AGENTS)\.md$|^\.(claude|codex|agents|cursor|gemini)\/|^\.mcp\.json$/;
function agentConfigFiles() {
  const files = new Set();
  for (const dir of [".claude", ".codex", ".agents", ".cursor", ".gemini"]) for (const p of listFiles(join(ROOT, dir))) files.add(p);
  if (existsSync(join(ROOT, ".mcp.json"))) files.add(join(ROOT, ".mcp.json"));
  for (const f of git("ls-files", "--cached", "--others", "--exclude-standard", "-z").toString().split("\0")) {
    if (f && /(^|\/)(CLAUDE|CLAUDE\.local|AGENTS)\.md$/.test(f)) files.add(join(ROOT, f));
  }
  for (const p of listFiles(SKILL_DIR)) files.add(p);
  return [...files];
}

function snapshot(runDir, callId, logPath) {
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...EXCLUDE).toString().split("\0").filter(Boolean);
  const project = sha(
    Buffer.concat([
      git("rev-parse", "-q", "--verify", "HEAD"),
      git("status", "--porcelain=v1", "--untracked-files=all", "--", ".", ...EXCLUDE),
      git("diff", "--binary", "--", ".", ...EXCLUDE),
      git("diff", "--cached", "--binary", "--", ".", ...EXCLUDE),
      ...untracked.map((f) => Buffer.from(`${f}\0${hashFile(join(ROOT, f))}\n`)),
    ]),
  );
  // Ignored files such as .env: hash the ones that exist, skip ignored directories (caches, builds).
  const ignored = {};
  for (const f of git("ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", ".", ...EXCLUDE).toString().split("\0")) {
    if (f && !f.endsWith("/")) ignored[f] = hashFile(join(ROOT, f));
  }
  // Files DENKEN owns: config, and everything in the run directory except this call's own files.
  const owned = {};
  for (const name of ["config.json", "config.local.json"]) {
    const p = join(DENKEN_DIR, name);
    if (existsSync(p)) owned[relative(ROOT, p)] = hashFile(p);
  }
  for (const p of listFiles(runDir)) {
    if (!relative(runDir, p).startsWith(`calls/${callId}.`)) owned[relative(ROOT, p)] = hashFile(p);
  }
  // The run's record, except raw/ and QA evidence: those can be large, and the engine alone
  // writes them, after each call.
  if (logPath) for (const p of listFiles(join(ROOT, logPath))) if (!/\/(raw|evidence)\//.test(relative(join(ROOT, logPath), p))) owned[relative(ROOT, p)] = hashFile(p);
  for (const p of agentConfigFiles()) owned[relative(ROOT, p)] = hashFile(p);
  return { project, ignored, owned };
}

// DENKEN's own files are restored from `pinned` when a call changes them. Project files are
// only reported: they belong to the user, who decides what to keep.
function violations(before, after, guard, runDir, pinned, callId) {
  const found = [];
  if (guard.frozen && before.project !== after.project) found.push("project files changed (inspect with git status and git diff)");
  // QA runs tests, which often rewrite ignored reports (coverage.xml and the like), so QA is
  // held only to env files. Reviewers and the planner run nothing and are held to all of them.
  const watched = guard.ignored === "all" ? () => true : guard.ignored === "env" ? (f) => /(^|\/)\.env/.test(f) : () => false;
  for (const [f, h] of Object.entries(before.ignored)) {
    if (watched(f) && hashFile(join(ROOT, f)) !== h) found.push(`ignored file changed: ${f}`);
  }
  const allowed = new Set(guard.allow.map((f) => relative(ROOT, join(runDir, f))));
  for (const f of new Set([...Object.keys(before.owned), ...Object.keys(after.owned)])) {
    if (before.owned[f] === after.owned[f] || allowed.has(f)) continue;
    const path = join(ROOT, f);
    // Keep what the call wrote, as evidence, before undoing it.
    if (existsSync(path) && callId) {
      const kept = join(runDir, "calls", `${callId}.tampered`, f.replace(/^(\.\.\/)+/, "outside/"));
      mkdirSync(dirname(kept), { recursive: true });
      copyFileSync(path, kept);
    }
    if (f in pinned) writeFileSync(path, pinned[f]);
    else if (!(f in before.owned)) rmSync(path, { force: true });
    found.push(`DENKEN file changed: ${f}${f in pinned || !(f in before.owned) ? " (restored)" : ""}`);
  }
  return found;
}

function pinOwned(owned) {
  const pinned = {};
  for (const f of Object.keys(owned)) if (!f.endsWith(".log")) pinned[f] = readFileSync(join(ROOT, f));
  return pinned;
}

// ---------- the request and the TODO lists
// request.md is DENKEN's summary of the conversation with the user:
//   ## Goal          the user's goal
//   ## Confirmed     "- REQ-001. ... Done when: ..."   what will be built
//   ## Out of scope  "- OUT-001. ..."                  what is not part of this work
//   ## Not now       "- LATER-001. ..."                what is deferred to later
//   ## Cautions      "- CAUTION-001. ..."              what to be careful about
// METHODE's todo-dev.md copies Confirmed (## Acceptance), Out of scope and Not now (## Do not
// build) and Cautions (## Cautions) word for word, so STARK can work from it alone, and lists
// "- [ ] DEV-001 (REQ-001) ..." under "## TODO". todo-qa.md lists "- [ ] QA-001 (REQ-001) ..."
// under "## Checks". todo-fix.md, written by the engine after a failed QA cycle, lists
// "- [ ] FIX-001 (QA-002, REQ-002) ..." under "## QA cycle <n>". A ticked item carries its
// evidence on the next line: "  Evidence: <what was done, and where>". Only METHODE words the
// items; only STARK ticks DEV and FIX items, through the tick command, with evidence.

const readRunFile = (runDir, name) => (existsSync(join(runDir, name)) ? readFileSync(join(runDir, name), "utf8") : "");

function section(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(l.trim()));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

// Items "- REQ-001. ..." in a section, each with the text of its line and any continuation lines.
function sectionItems(body, prefix) {
  const items = [];
  for (const line of (body ?? "").split("\n")) {
    const m = line.match(new RegExp(`^\\s*[-*]\\s*[*_\`]*(${prefix}-\\d{3,})\\b`));
    if (m) items.push({ key: m[1], text: line });
    else if (items.length && line.trim() && !/^\s*[-*]\s/.test(line.slice(0, 2))) items.at(-1).text += `\n${line}`;
  }
  return items;
}

const REQUEST_SECTIONS = { REQ: "Confirmed", OUT: "Out of scope", LATER: "Not now", CAUTION: "Cautions" };

function parseRequest(text) {
  const parsed = { goal: section(text, "Goal") };
  for (const [prefix, heading] of Object.entries(REQUEST_SECTIONS)) {
    const body = section(text, heading);
    parsed[prefix] = { present: body !== null, items: sectionItems(body, prefix) };
  }
  return parsed;
}

function requestProblems(text) {
  const r = parseRequest(text);
  const problems = [];
  if (!r.goal?.trim()) problems.push('request.md needs a "## Goal" section with the user\'s goal');
  if (!r.REQ.present || !r.REQ.items.length) problems.push('request.md needs a "## Confirmed" section with items "- REQ-001. ... Done when: ..."');
  for (const item of r.REQ.items) if (!/done when/i.test(item.text)) problems.push(`${item.key} needs a "Done when:" condition someone could check`);
  for (const prefix of ["OUT", "LATER", "CAUTION"]) {
    if (!r[prefix].present) problems.push(`request.md needs a "## ${REQUEST_SECTIONS[prefix]}" section (items "- ${prefix}-001. ...", or "- None")`);
  }
  const unclear = [...text.matchAll(/\[NEEDS CLARIFICATION:([^\]]*)\]/gi)].map((m) => m[1].trim());
  if (unclear.length) problems.push(`request.md still has open questions for the user: ${unclear.join("; ")}`);
  return problems;
}

// An item's text as a contract: only whitespace, the bullet, emphasis and case may differ.
const contract = (text) => text.replace(/^\s*[-*]\s*/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

// Ids are never reused. Once the user has confirmed an item, its id keeps that wording; a changed
// item gets a new id, so findings, rulings and TODO references keep meaning what they meant.
function requestItems(runDir) {
  const r = parseRequest(readRunFile(runDir, REQUEST));
  return Object.keys(REQUEST_SECTIONS).flatMap((p) => r[p].items);
}
function reusedIds(runDir, state) {
  const confirmed = state.requestIds ?? {};
  return requestItems(runDir)
    .filter((i) => i.key in confirmed && confirmed[i.key] !== contract(i.text))
    .map((i) => `${i.key} now reads differently from what the user confirmed. Ids are never reused: restore ${i.key}, or remove it and add the new wording under a number not used before`);
}

// ---------- units: one request built in parallel
// units.md, DENKEN's optional split of the request into units that are built at the same time:
//   - UNIT-1 (REQ-001, REQ-002) <title>. Scope: `src/a/`, `test/a/`.
// Each unit gets its own git worktree and runs plan, dev (with review) and QA there; when every
// unit is done, the engine merges them and verifies the whole again. Work whose scope or
// dependencies overlap is not split: it belongs in one unit, where its items run in order.
const UNITS = "units.md";
const MAX_UNITS = 9;
function parseUnits(text) {
  const units = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*[-*]\s*[*_`]*(UNIT-(\d+))\b[*_`]*\s*\(([^)]*)\)\s*(.*)$/);
    if (!m) continue;
    const [, id, n, refs, rest] = m;
    const scopeText = rest.match(/\bScope:\s*(.*)$/i)?.[1] ?? "";
    units.push({
      id,
      n: Number(n),
      reqs: refs.match(/\bREQ-\d{3,}\b/g) ?? [],
      title: rest.replace(/\bScope:.*$/i, "").trim().replace(/[.\s]+$/, ""),
      scope: [...scopeText.matchAll(/`([^`]+)`/g)].map((x) => x[1].trim()),
    });
  }
  return units;
}
// A scope entry is a directory ("src/a/", or a name without an extension) or a file.
const scopeDir = (entry) => entry.endsWith("/") || !/\.\w+$/.test(basename(entry));
const inScope = (scope, file) => scope.some((e) => (scopeDir(e) ? file.startsWith(`${e.replace(/\/$/, "")}/`) : file === e));
const scopesOverlap = (a, b) => {
  const x = a.replace(/\/$/, "");
  const y = b.replace(/\/$/, "");
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
};
function unitsProblems(runDir) {
  const units = parseUnits(readRunFile(runDir, UNITS));
  const problems = [];
  if (units.length < 2) return { units, problems: [`${UNITS} needs at least two units to split the work; without it, the request runs as one`] };
  if (units.length > MAX_UNITS) problems.push(`${UNITS} has ${units.length} units; at most ${MAX_UNITS}`);
  const reqs = parseRequest(readRunFile(runDir, REQUEST)).REQ.items.map((i) => i.key);
  units.forEach((u, i) => {
    if (u.n !== i + 1) problems.push(`number the units in order from UNIT-1 (found ${u.id} in place ${i + 1})`);
    if (!u.reqs.length) problems.push(`${u.id} names no REQ items`);
    if (!u.title) problems.push(`${u.id} needs a title`);
    if (!u.scope.length) problems.push(`${u.id} needs a scope: the paths it may change, as \`src/a/\`, \`test/a/\``);
    for (const e of u.scope) if (/^\/|(^|\/)\.\.(\/|$)|[*?[\]{}]/.test(e) || !e.trim()) problems.push(`${u.id}: scope "${e}" must be a plain path inside the project, without globs`);
    for (const r of u.reqs) if (!reqs.includes(r)) problems.push(`${u.id} names ${r}, which request.md does not define`);
  });
  for (const r of reqs) {
    const owners = units.filter((u) => u.reqs.includes(r)).map((u) => u.id);
    if (owners.length !== 1) problems.push(owners.length ? `${r} is in ${owners.join(" and ")}; each REQ item belongs to exactly one unit` : `${r} is in no unit`);
  }
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      for (const a of units[i].scope) for (const b of units[j].scope) {
        if (scopesOverlap(a, b)) problems.push(`${units[i].id} and ${units[j].id} overlap at ${a === b ? a : `${a} and ${b}`}: work whose scope overlaps is not split. Put it in one unit, where its items run in order`);
      }
    }
  }
  return { units, problems };
}

// Units are built in git worktrees outside the project, so the project's own tools (test
// runners, tsc, linters) never pick them up, and each unit's agents are confined to their own.
const WORKTREES = process.env.DENKEN_WORKTREES || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "denken", "worktrees");
// Dependencies installed in the project, linked one level above the units' worktrees, where
// module resolution finds them and git in the worktree does not see them.
const SHARED_DEPS = ["node_modules"];

// The commit every unit starts from: the project as it is now, uncommitted and untracked files
// included, built with plumbing (a temporary index, write-tree, commit-tree), so no hook runs and
// no branch, index or working file of the project changes.
function unitBaseCommit(runDir) {
  const head = gitText("rev-parse", "-q", "--verify", "HEAD");
  if (!head) fail("parallel units start from a commit: commit once, or remove units.md to run the request as one");
  const index = join(runDir, "base.index");
  rmSync(index, { force: true });
  const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "DENKEN", GIT_AUTHOR_EMAIL: "denken@localhost", GIT_COMMITTER_NAME: "DENKEN", GIT_COMMITTER_EMAIL: "denken@localhost" };
  const steps = [["read-tree", head], ["add", "-A", "--", ".", ...EXCLUDE]];
  for (const step of steps) {
    const r = gitAt(ROOT, step, { env });
    if (!r.ok) fail(`could not record the project for the units (git ${step[0]}): ${r.err}`);
  }
  const tree = gitAt(ROOT, ["write-tree"], { env }).out.toString("utf8").trim();
  const commit = gitAt(ROOT, ["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", head, "-m", `DENKEN base for ${basename(runDir)}`], { env });
  rmSync(index, { force: true });
  if (!commit.ok) fail(`could not record the project for the units: ${commit.err}`);
  return commit.out.toString("utf8").trim();
}
function addWorktree(path, commit) {
  mkdirSync(dirname(path), { recursive: true });
  const r = gitAt(ROOT, ["worktree", "add", "--detach", path, commit]);
  if (!r.ok) fail(`git worktree add failed for ${path}: ${r.err}`);
  // A locked worktree survives "git worktree prune" while its unit works in it.
  gitAt(ROOT, ["worktree", "lock", "--reason", "DENKEN unit in progress", path]);
}
function removeWorktree(path) {
  if (existsSync(path)) gitAt(ROOT, ["worktree", "remove", "--force", "--force", path]);
  rmSync(path, { recursive: true, force: true });
}

// A unit's request.md: the request narrowed to the unit's REQ items, with everything that bounds
// it (out of scope, not now, cautions) and a Unit section: its scope, its numbers, and the units
// built beside it.
function unitRequest(runDir, unit, units) {
  const text = readRunFile(runDir, REQUEST);
  const r = parseRequest(text);
  const list = (prefix) => r[prefix].items.map((i) => i.text).join("\n") || "- None";
  const scope = unit.scope.map((e) => `\`${e}\``).join(", ");
  const others = units.filter((u) => u.id !== unit.id).map((u) => `  - ${u.id} (${u.reqs.join(", ")}) ${u.title}. Scope: ${u.scope.map((e) => `\`${e}\``).join(", ")}.`);
  const decisions = section(text, "Decisions")?.trim();
  return [
    `# Request: ${text.match(/^#\s+(?:Request:\s*)?(.*)$/m)?.[1]?.trim() ?? "task"} · ${unit.id}: ${unit.title}`,
    "",
    "## Goal",
    r.goal.trim(),
    "",
    `This run builds ${unit.id} of that goal, "${unit.title}", while other units are built at the same time.`,
    "",
    "## Confirmed",
    r.REQ.items.filter((i) => unit.reqs.includes(i.key)).map((i) => i.text).join("\n"),
    "",
    "## Out of scope",
    list("OUT"),
    "",
    "## Not now",
    list("LATER"),
    "",
    "## Cautions",
    list("CAUTION"),
    "",
    "## Unit",
    `- ${unit.id}: ${unit.title}.`,
    `- Scope: ${scope}. Change files only there: a change anywhere else goes back to STARK. If an item cannot be done inside the scope, say so under Open questions, and DENKEN will change the split.`,
    `- Number this unit's items from ${unit.n * 100 + 1}: DEV-${unit.n * 100 + 1}, QA-${unit.n * 100 + 1}, and so on.`,
    "- Built by other units at the same time, not by this one:",
    ...others,
    ...(decisions ? ["", "## Decisions", decisions] : []),
    "",
  ].join("\n");
}

// The parent's fields every run needs, for a new run or a unit's.
function runFields(assignment, baseRef) {
  return {
    assignment,
    baseRef,
    round: { plan: 0, dev: 0, qa: 0, wiki: 0 },
    stageBase: {},
    counts: { plan: {}, dev: {}, wiki: {} },
    findings: { plan: [], dev: [], wiki: [] },
    history: { plan: [], dev: [], wiki: [] },
    historyBase: {},
    capBase: {},
    dismissed: {},
    ruled: {},
    denialStreak: {},
    lastReview: {},
    lastWork: {},
    lastQa: null,
    devInput: null,
    deferred: [],
    rulings: [],
    approved: { plan: null, dev: null, qa: null, wiki: null },
    calls: [],
    inflight: null,
    blocked: null,
    retryCall: null,
  };
}

// One worktree and one run per unit, all from the same base commit. The parent keeps where each
// unit lives: commands for a unit go through the parent (--unit), never by what the unit's own
// files claim.
function createUnits(runDir, state, units) {
  const home = join(WORKTREES, `${slug(basename(ROOT))}-${sha(ROOT).slice(0, 8)}`, basename(runDir));
  tearDownUnits(state);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  for (const dep of SHARED_DEPS) {
    if (existsSync(join(ROOT, dep)) && gitAt(ROOT, ["check-ignore", "-q", dep]).ok) symlinkSync(join(ROOT, dep), join(home, dep));
  }
  const base = unitBaseCommit(runDir);
  state.unitHome = home;
  state.unitBase = base;
  state.units = units.map((u) => {
    const root = join(home, u.id);
    addWorktree(root, base);
    const run = join(root, ".denken", "runs", basename(runDir));
    mkdirSync(join(run, "calls"), { recursive: true });
    if (!existsSync(join(root, ".denken", ".gitignore"))) writeFileSync(join(root, ".denken", ".gitignore"), "*\n");
    writeFileSync(join(run, REQUEST), unitRequest(runDir, u, units));
    const child = { version: 1, task: `${state.task} · ${u.id}`, created: now(), log: logDir(state), verdicts: [], unit: u.id, title: u.title, mainRoot: ROOT, idBase: u.n * 100, scope: u.scope, ...runFields(state.assignment, base) };
    enterStage(child, "plan");
    logRequest(child, run);
    timeline(child, "DENKEN", `${u.id} (${u.reqs.join(", ")}) "${u.title}" starts in its own worktree; scope ${u.scope.join(", ")}`);
    save(run, child);
    return { id: u.id, n: u.n, title: u.title, reqs: u.reqs, scope: u.scope, root: realpathSync(root), run: realpathSync(run), started: false, status: "queued", last: null, pulled: 0 };
  });
  state.mainPrint = projectPrint(runDir);
}
function tearDownUnits(state) {
  for (const u of state.units ?? []) removeWorktree(u.root);
  if (state.unitHome) removeWorktree(join(state.unitHome, "INTEGRATION"));
  gitAt(ROOT, ["worktree", "prune"]);
}

// The project as the units found it: tracked, untracked and ignored files and agent
// configuration, without DENKEN's own run and record. It must not change while units work.
function projectPrint(runDir) {
  const s = snapshot(runDir, "", null);
  const mine = `${relative(ROOT, runDir)}/`;
  return sha(JSON.stringify([s.project, s.ignored, Object.entries(s.owned).filter(([f]) => !f.startsWith(mine))]));
}

const ITEM = {
  DEV: { file: TODO_DEV, heading: /^##\s+TODO\s*$/i, name: "TODO" },
  QA: { file: TODO_QA, heading: /^##\s+Checks\s*$/i, name: "Checks" },
  FIX: { file: TODO_FIX, heading: /^##\s+QA cycle\b/i, name: "QA cycle <n>" },
};
const EVIDENCE_LINE = /^\s+Evidence:\s*(.*)$/;
const blockedIn = (report, key) => new RegExp(`\\b${key}\\b[^\\n]*\\bblocked\\b`, "i").test(report);

function inItemSection(lines, i, heading) {
  for (let j = i; j >= 0; j--) if (/^##\s/.test(lines[j])) return heading.test(lines[j].trim());
  return false;
}

// Items of one kind in their section: checkbox, references, text, block (with continuation lines)
// and evidence. A line there that looks like an item but is not a checkbox line, a repeated id,
// or a missing section is reported, never skipped: STARK reads the whole file, so an unparsed
// item would escape the checks. Tolerates "- [ ] **DEV-001** (REQ-001) ..." and similar.
function parseItems(text, prefix) {
  const lines = text.split("\n");
  const items = [];
  const problems = [];
  if (!lines.some((l) => ITEM[prefix].heading.test(l.trim()))) problems.push({ key: "section", problem: `the "## ${ITEM[prefix].name}" section is missing` });
  let cycle = null;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      current = null;
      cycle = Number(line.match(/^##\s+QA cycle\s+(\d+)/i)?.[1]) || null;
      continue;
    }
    if (!inItemSection(lines, i, ITEM[prefix].heading)) continue;
    const m = line.match(new RegExp(`^\\s*[-*]\\s*\\[([ xX])\\]\\s*[*_\`]*(${prefix}-\\d{3,})\\b[*_\`]*\\s*[:.]?\\s*(?:\\(([^)]*)\\))?(.*)$`));
    if (m) {
      current = null;
      if (items.some((x) => x.key === m[2])) {
        problems.push({ key: m[2], problem: `${m[2]} appears more than once` });
        continue;
      }
      current = { key: m[2], done: m[1] !== " ", refs: (m[3] ?? "").match(/\b(?:REQ|OUT|LATER|QA)-\d{3,}\b/g) ?? [], text: m[4].trim(), block: line, evidence: null, cycle };
      items.push(current);
      continue;
    }
    if (current && /^\s{2,}\S/.test(line)) {
      current.block += `\n${line}`;
      const e = line.match(EVIDENCE_LINE);
      if (e && current.evidence === null) current.evidence = e[1].trim();
      continue;
    }
    const loose = line.match(new RegExp(`^[-*]\\s*[*_\`]*(${prefix}-\\d{3,})\\b`));
    if (loose) problems.push({ key: loose[1], problem: `${loose[1]} is not a checkbox line ("- [ ] ${loose[1]} ...")` });
    if (line.trim()) current = null;
  }
  return { items, problems };
}

const fixItems = (runDir) => parseItems(readRunFile(runDir, TODO_FIX), "FIX").items;

// Bullet lines under "## Open questions" in todo-dev.md, other than "None".
function openQuestions(runDir) {
  return (section(readRunFile(runDir, TODO_DEV), "Open questions") ?? "")
    .split("\n")
    .filter((l) => /^\s*[-*]\s+\S/.test(l) && !/^\s*[-*]\s+(none|n\/a)\b/i.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
}

// The plan as the user confirmed it: ticks and evidence lines are progress, not a change to it.
const planText = (text) => text.split("\n").filter((l) => !EVIDENCE_LINE.test(l)).join("\n").replace(/^(\s*[-*]\s*)\[[xX]\]/gm, "$1[ ]");

function confirmedHashes(runDir) {
  return { request: sha(readRunFile(runDir, REQUEST)), todoDev: sha(planText(readRunFile(runDir, TODO_DEV))), todoQa: sha(planText(readRunFile(runDir, TODO_QA))) };
}

// Coverage gaps, each with its own identity so one gap cannot hide or dismiss another.
function todoGaps(runDir) {
  const req = parseRequest(readRunFile(runDir, REQUEST));
  const devText = readRunFile(runDir, TODO_DEV);
  const devParse = parseItems(devText, "DEV");
  const qaParse = parseItems(readRunFile(runDir, TODO_QA), "QA");
  const dev = devParse.items;
  const qa = qaParse.items;
  const gaps = [];
  const gap = (identity, file, request_item, todo, problem, required_change) =>
    gaps.push({ identity, severity: "blocking", topic: identity, file, line_start: null, line_end: null, request_item, todo, problem, required_change, source: "engine" });
  const known = new Set([...req.REQ.items, ...req.OUT.items, ...req.LATER.items].map((i) => i.key));

  if (!dev.length) gap("todo-dev-empty", TODO_DEV, null, null, "todo-dev.md has no DEV items", 'Write the development TODO under "## TODO" as "- [ ] DEV-001 (REQ-001) ..." items.');
  if (!qa.length) gap("todo-qa-empty", TODO_QA, null, null, "todo-qa.md has no QA items", 'Write the QA TODO under "## Checks" as "- [ ] QA-001 (REQ-001) ..." items.');
  for (const [file, parsed] of [[TODO_DEV, devParse], [TODO_QA, qaParse]]) {
    for (const p of parsed.problems) gap(`todo-format-${p.key}`, file, null, p.key === "section" ? null : p.key, `${file}: ${p.problem}`, "Fix the list format: one checkbox line per item, each id once, inside its section.");
  }
  // STARK's contract is the copied text itself, so the copies must match request.md.
  for (const [heading, prefixes] of [["Acceptance", ["REQ"]], ["Do not build", ["OUT", "LATER"]], ["Cautions", ["CAUTION"]]]) {
    const body = section(devText, heading);
    for (const prefix of prefixes) {
      const copied = new Map(sectionItems(body, prefix).map((i) => [i.key, contract(i.text)]));
      for (const item of req[prefix].items) {
        const reqItem = prefix === "REQ" ? item.key : null;
        if (!copied.has(item.key)) gap(`todo-copy-${item.key}`, TODO_DEV, reqItem, null, `${item.key} is missing from the ${heading} section of todo-dev.md`, `Copy ${item.key} from request.md into "## ${heading}", word for word.`);
        else if (copied.get(item.key) !== contract(item.text)) gap(`todo-copy-${item.key}`, TODO_DEV, reqItem, null, `${item.key} in the ${heading} section of todo-dev.md differs from request.md`, `Copy ${item.key} from request.md word for word.`);
      }
    }
  }
  for (const item of req.REQ.items) {
    if (dev.length && !dev.some((d) => d.refs.includes(item.key))) gap(item.key, TODO_DEV, item.key, null, `${item.key} has no development TODO`, `Add a DEV item that implements ${item.key}.`);
    if (qa.length && !qa.some((q) => q.refs.includes(item.key))) gap(item.key, TODO_QA, item.key, null, `${item.key} has no QA TODO`, `Add a QA item that verifies ${item.key}.`);
  }
  for (const d of dev) {
    if (!d.refs.some((r) => r.startsWith("REQ-"))) gap(d.key, TODO_DEV, null, d.key, `${d.key} does not name the request item it implements`, `Add the REQ item(s) in parentheses after ${d.key}.`);
    for (const r of d.refs) {
      if (/^(OUT|LATER)-/.test(r)) gap(d.key, TODO_DEV, null, d.key, `${d.key} builds ${r}, which the request ${r.startsWith("OUT-") ? "puts out of scope" : "defers (not now)"}`, `Remove ${d.key} or the work for ${r}.`);
      else if (!known.has(r)) gap(d.key, TODO_DEV, null, d.key, `${d.key} refers to ${r}, which request.md does not define`, "Refer only to REQ items in request.md.");
    }
  }
  for (const q of qa) {
    if (!q.refs.length) gap(q.key, TODO_QA, null, q.key, `${q.key} does not name the request item it verifies`, `Add the REQ, OUT or LATER item in parentheses after ${q.key}.`);
    for (const r of q.refs) if (!known.has(r)) gap(q.key, TODO_QA, null, q.key, `${q.key} refers to ${r}, which request.md does not define`, "Refer only to items in request.md.");
  }
  return gaps;
}

// ---------- ticking items off, with evidence
// STARK ticks a DEV or FIX item off only through `denken.mjs tick`, which checks the evidence, runs
// the item's test command and, only when it passes, records the tick in a ledger
// (calls/<call>.ticks.jsonl, output in calls/<call>.tick-<item>.log). When the call ends, the engine
// writes each recorded tick and its evidence into the TODO file. The engine is the only writer of
// ticks and evidence, so STARK may not change the TODO files at all. Unticking is the engine's too.

// Evidence as it is written under an item: one line, at most 400 characters. The full text stays
// in the tick ledger and the step file.
function evidenceLine(evidence) {
  const flat = String(evidence).replace(/\s+/g, " ").trim();
  return flat.length <= 400 ? flat : `${flat.slice(0, 360)} … (truncated; full text in the tick record)`;
}
function setTick(runDir, prefix, key, ticked, evidence = null) {
  const path = join(runDir, ITEM[prefix].file);
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(new RegExp(`^\\s*[-*]\\s*\\[[ xX]\\]\\s*[*_\`]*(${prefix}-\\d{3,})\\b`));
    if (!m || m[1] !== key || !inItemSection(lines, i, ITEM[prefix].heading)) continue;
    lines[i] = lines[i].replace(/\[[ xX]\]/, ticked ? "[x]" : "[ ]");
    let j = i + 1;
    while (j < lines.length && /^\s{2,}\S/.test(lines[j]) && !EVIDENCE_LINE.test(lines[j])) j++;
    const has = j < lines.length && EVIDENCE_LINE.test(lines[j]);
    if (ticked && evidence) {
      const line = `  Evidence: ${evidenceLine(evidence)}`;
      if (has) lines[j] = line;
      else lines.splice(i + 1, 0, line);
    } else if (!ticked && has) lines.splice(j, 1);
    writeFileSync(path, lines.join("\n"));
    return true;
  }
  return false;
}

// Ledger entries whose output log is intact, keyed by item, latest first wins.
function tickLedger(runDir) {
  const entries = new Map();
  for (const f of existsSync(join(runDir, "calls")) ? readdirSync(join(runDir, "calls")) : []) {
    if (!/^dev-stark-\d+\.ticks\.jsonl$/.test(f)) continue;
    for (const line of readFileSync(join(runDir, "calls", f), "utf8").split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.exitCode === 0 && hashFile(join(runDir, "calls", e.log)) === e.logSha && (!entries.has(e.item) || e.at > entries.get(e.item).at)) entries.set(e.item, e);
      } catch {}
    }
  }
  return entries;
}

// After STARK's call: every DEV item, and every FIX item of the current QA cycle, is either
// ticked off with evidence and a passing test run recorded since it was last unticked, or
// reported blocked in dev-report.md.
// Ticks recorded by one call, the latest per item, applied to the TODO files when the call ends.
// The ledger is one of STARK's own call files, so every check the tick command made is made
// again here; an entry that fails one is not applied, and goes back to STARK with the reason.
// Each applied tick's base (when, and the changed files' state) is kept in state.json, the only
// place itemBase reads it from.
function applyTicks(runDir, state, call) {
  const latest = new Map();
  for (const line of readRunFile(runDir, `calls/${call.id}.ticks.jsonl`).split("\n").filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e.item === "string") latest.set(e.item, e);
    } catch {}
  }
  const applied = [];
  const rejected = [];
  for (const [key, e] of latest) {
    const problem = tickProblem(runDir, state, call, e);
    if (problem) {
      rejected.push({ item: key, problem });
      continue;
    }
    setTick(runDir, key.split("-")[0], key, true, e.evidence);
    (state.tickBases ??= {})[key] = { at: now(), call: call.id };
    applied.push(e);
  }
  // Bases are taken after every tick of the call is applied, from the files as the call left them.
  const tree = changeTree(state);
  for (const e of applied) state.tickBases[e.item].tree = tree;
  return { applied, rejected };
}
function tickProblem(runDir, state, call, e) {
  const prefix = /^(DEV|FIX)-\d{3,}$/.test(e.item) ? e.item.split("-")[0] : null;
  if (!prefix) return "it is not a DEV or FIX item";
  const items = prefix === "DEV" ? parseItems(readRunFile(runDir, TODO_DEV), "DEV").items : fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle);
  if (!items.some((x) => x.key === e.item)) return prefix === "DEV" ? "it is not in the TODO section of todo-dev.md" : "it is not a recovery item of the current QA cycle";
  if (typeof e.evidence !== "string" || !e.evidence.trim() || typeof e.noChange !== "boolean") return "the record has no evidence";
  if (e.noChange ? !/^No change needed: \S/.test(e.evidence) : /^No change needed:/.test(e.evidence)) return "the record mixes --evidence and --no-change";
  if (e.log !== `${call.id}.tick-${e.item}.log`) return "the record points to the wrong test log";
  const log = readRunFile(runDir, `calls/${e.log}`);
  if (typeof e.command !== "string" || !log.startsWith(`$ ${e.command}\n`) || !/\n\[exit 0\]\n?$/.test(log)) return "its test log does not show the recorded command passing";
  if (!e.noChange) {
    const base = itemBase(runDir, state, e.item);
    if (!changedSince(state, base.tree).some((f) => namesFile(e.evidence, f))) return `its evidence names no file changed for it since ${base.what}`;
  }
  return null;
}

// The files this stage has changed, each with a hash of its content ("missing" once deleted).
// Comparing two of these tells which files changed in between, reverts included.
const changeTree = (state) => Object.fromEntries(stageChanges(state, "dev").changed.map((f) => [f, hashFile(join(ROOT, f))]));
function changedSince(state, tree) {
  const current = changeTree(state);
  // A file missing from the older tree was as the stage began; it changed if it differs now.
  return [...new Set([...Object.keys(current), ...Object.keys(tree)])].filter((f) => (f in tree ? hashFile(join(ROOT, f)) !== tree[f] : true)).sort();
}

// Where an item's evidence is measured from: whichever came last of the start of development, the
// item's own last applied tick, the engine unticking it, and (for a FIX item) the QA cycle that
// wrote it. All of these come from state.json, which only the engine writes.
function itemBase(runDir, state, key) {
  const start = state.stageEnteredAt?.dev ?? "";
  const bases = [{ at: start, tree: {}, what: "development began" }];
  const t = state.tickBases?.[key];
  if (t?.tree) bases.push({ at: t.at, tree: t.tree, what: `${key} was last ticked (${t.call})` });
  const u = state.unticked?.[key];
  if (u) bases.push({ at: u.at, tree: u.tree, what: `the engine unticked ${key} after QA failed` });
  const cycle = key.startsWith("FIX-") ? state.fixCycles?.[state.currentFixCycle] : null;
  if (cycle?.tree) bases.push({ at: cycle.at, tree: cycle.tree, what: `QA cycle ${state.currentFixCycle} wrote ${key}` });
  return bases.filter((b) => b.at >= start).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
}

// Does the evidence name this file, by its path or by its file name (when it has an extension),
// as a whole name? "a.js" does not name "a.jsx" or "a.js.bak".
function namesFile(evidence, file) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forms = [file, ...(/\.\w+$/.test(basename(file)) ? [basename(file)] : [])];
  return forms.some((n) => new RegExp(`(^|[^\\w./-])${esc(n)}(?=$|[^\\w./-]|\\.(?:$|\\s))`).test(evidence));
}

// A unit's plan stays inside its numbers and its scope.
function unitPlanGaps(runDir, state) {
  if (!state.unit) return [];
  const gaps = [];
  const gap = (identity, file, todo, problem, required_change) => gaps.push({ identity, severity: "blocking", topic: identity, file, line_start: null, line_end: null, request_item: null, todo, problem, required_change, source: "engine" });
  const lo = state.idBase + 1;
  const hi = state.idBase + 99;
  for (const [file, prefix] of [[TODO_DEV, "DEV"], [TODO_QA, "QA"]]) {
    for (const i of parseItems(readRunFile(runDir, file), prefix).items) {
      const n = Number(i.key.split("-")[1]);
      if (n < lo || n > hi) gap(`todo-range-${i.key}`, file, i.key, `${i.key} is outside ${state.unit}'s numbers`, `Number ${state.unit}'s items from ${prefix}-${lo} to ${prefix}-${hi}.`);
    }
  }
  for (const d of parseItems(readRunFile(runDir, TODO_DEV), "DEV").items) {
    const outside = namedPaths(d).filter((p) => !inScope(state.scope, p));
    if (outside.length) gap(`todo-scope-${d.key}`, TODO_DEV, d.key, `${d.key} names ${outside.join(", ")}, outside ${state.unit}'s scope (${state.scope.join(", ")})`, "Keep the item inside the scope. If it cannot be done without changing those files, say so under Open questions: DENKEN will change the split.");
  }
  return gaps;
}
// The files a DEV item names: its "Files:" list, and paths in backticks. A name counts when it
// exists in the project, or its folder does (a new file); code such as `text.length` does not.
function namedPaths(item) {
  const text = item.block.split("\n").filter((l) => !EVIDENCE_LINE.test(l)).join(" ");
  const listed = (text.match(/\bFiles:\s*(.*?)(?:\.\s+[A-Z]|\bUnit tests:|$)/)?.[1] ?? "").split(/[\s,;()]+/);
  const quoted = [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((t) => t.includes("/"));
  return [...new Set([...listed, ...quoted].map((t) => t.replace(/^[`'"]+|[`'".:]+$/g, "")))]
    .filter((t) => /^[\w@.\/-]+$/.test(t) && !t.startsWith("/") && !t.includes("..") && (t.includes("/") || /\.\w+$/.test(t)))
    .filter((t) => existsSync(join(ROOT, t)) || (dirname(t) !== "." && existsSync(join(ROOT, dirname(t)))));
}
// A unit changes only files in its scope: anything else could collide with another unit.
function unitScopeGaps(state) {
  if (!state.unit) return [];
  return stageChanges(state, "dev").changed.filter((f) => !inScope(state.scope, f)).map((f) => ({
    identity: `scope-${f}`, severity: "blocking", topic: `scope-${f}`, file: f, line_start: null, line_end: null, request_item: null, todo: null, source: "engine",
    problem: `${f} changed, outside ${state.unit}'s scope (${state.scope.join(", ")})`,
    required_change: `Undo the change to ${f}. If an item cannot be done without it, report the item blocked in dev-report.md with the reason: DENKEN will change the split.`,
  }));
}

function devGaps(runDir, state, rejected = []) {
  const report = readRunFile(runDir, "dev-report.md");
  const items = [
    ...parseItems(readRunFile(runDir, TODO_DEV), "DEV").items.map((d) => ({ ...d, file: TODO_DEV })),
    ...fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle).map((f) => ({ ...f, file: TODO_FIX })),
  ];
  const gaps = [];
  for (const d of items) {
    if (d.done || blockedIn(report, d.key)) continue;
    const refused = rejected.find((r) => r.item === d.key);
    gaps.push({ identity: d.key, severity: "blocking", topic: d.key, file: d.file, line_start: null, line_end: null, request_item: d.refs.find((r) => r.startsWith("REQ-")) ?? null, todo: d.key, source: "engine", problem: refused ? `${d.key}'s recorded tick was not accepted: ${refused.problem}` : `${d.key} is neither ticked off nor reported blocked in dev-report.md`, required_change: `Finish ${d.key} and tick it off with the tick command and its evidence, or report "${d.key} blocked: <reason>" in dev-report.md.` });
  }
  return gaps;
}

// Files changed since a stage began: tracked changes against its base, plus untracked files that
// did not exist when it began.
function stageChanges(state, stage) {
  const lines = (text) => text.split("\n").filter(Boolean);
  const before = new Set(state.untrackedAtStage?.[stage] ?? []);
  const untracked = lines(gitText("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE)).filter((f) => !before.has(f));
  const changed = [...new Set([...lines(gitText("diff", "--name-only", state.stageBase[stage] || EMPTY_TREE, "--", ".", ...EXCLUDE)), ...untracked])];
  return { changed, untracked };
}

// Documentation, as far as the wiki stage is concerned.
const isDoc = (f) => !AGENT_CONTEXT.test(f) && (/\.(md|mdx|rst|adoc)$/i.test(f) || /(^|\/)(docs?|wiki)\//i.test(f));

// Existing docs that mention a changed code file: by path, or by its name without extension when
// that name is unique in the project and not a generic one. Docs mentioning a deleted file must be
// updated. The list is capped so a common name cannot flood SERIE.
const GENERIC_NAMES = new Set(["index", "main", "utils", "util", "config", "api", "app", "types", "type", "test", "tests", "readme", "lib", "src", "helpers", "helper", "common", "constants", "core", "base", "model", "models", "mod", "init", "setup", "server", "client"]);
function relatedDocs(changed, deleted = []) {
  const lines = (text) => text.split("\n").filter(Boolean);
  const files = [...new Set([...lines(gitText("ls-files", "--", ".", ...EXCLUDE)), ...lines(gitText("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE))])];
  const docs = files.filter(isDoc);
  const nameOf = (f) => basename(f).replace(/\.[^.]+$/, "");
  const counts = new Map();
  for (const f of [...files, ...deleted]) counts.set(nameOf(f), (counts.get(nameOf(f)) ?? 0) + 1);
  const code = [...new Set([...changed, ...deleted])].filter((f) => !isDoc(f) && !AGENT_CONTEXT.test(f));
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = [];
  for (const doc of docs) {
    let text;
    try {
      text = readFileSync(join(ROOT, doc), "utf8");
    } catch {
      continue;
    }
    const byPath = code.filter((f) => text.includes(f));
    const byName = code.filter((f) => !byPath.includes(f) && counts.get(nameOf(f)) === 1 && nameOf(f).length >= 3 && !GENERIC_NAMES.has(nameOf(f).toLowerCase()) && new RegExp(`\\b${escape(nameOf(f))}\\b`).test(text));
    const mentions = [...byPath, ...byName];
    if (mentions.length) found.push({ doc, mentions, byPath: byPath.length, mustUpdate: mentions.some((f) => deleted.includes(f)) });
  }
  return found.sort((x, y) => Number(y.mustUpdate) - Number(x.mustUpdate) || y.byPath - x.byPath || y.mentions.length - x.mentions.length).slice(0, 10);
}

// After SERIE's call: in the wiki stage only documentation may change.
function wikiGaps(state) {
  return stageChanges(state, "wiki")
    .changed.filter((f) => !isDoc(f))
    .map((f) => ({
      identity: `wiki-nondoc-${f}`,
      severity: "blocking",
      topic: "wiki-nondoc",
      file: f,
      line_start: null,
      line_end: null,
      request_item: null,
      todo: null,
      problem: `${f} changed in the wiki stage, and it is not documentation`,
      required_change: `Undo your change to ${f}. In the wiki stage only documentation may change; report code problems under known limitations instead.`,
      source: "engine",
    }));
}

// Facts for UBEL: each item's status, evidence and test run, the change's scope against the files
// the DEV items name, and signs of weakened tests.
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.\w+$|_test\.\w+$/;
const SKIP_MARKER = /\.skip\(|\bxit\(|\bxdescribe\(|\bxtest\(|@pytest\.mark\.skip|\bt\.Skip\(|skip:\s*true|\.todo\(/;

function scopeReport(runDir, state) {
  const base = state.stageBase.dev || EMPTY_TREE;
  const { changed, untracked } = stageChanges(state, "dev");
  const report = readRunFile(runDir, "dev-report.md");
  const ledger = tickLedger(runDir);
  const items = parseItems(readRunFile(runDir, TODO_DEV), "DEV").items;
  const fixes = fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle);
  const pathLike = (t) => /^[\w.\/-]+$/.test(t) && (t.includes("/") || /\.\w+$/.test(t));
  // A name without an extension is taken as a directory, and covers everything under it.
  const covers = (name, file) => file === name || (!/\.\w+$/.test(name) && file.startsWith(`${name.replace(/\/$/, "")}/`));
  const planned = (d) => d.block.split("\n").filter((l) => !EVIDENCE_LINE.test(l)).join("\n");
  const named = new Map(items.map((d) => [d.key, [...planned(d).matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(pathLike)]));
  const allNamed = [...named.values()].flat();
  const ticked = items.filter((d) => d.done);

  const status = [...items, ...fixes].map((d) => {
    const e = ledger.get(d.key);
    const run = e ? `, test \`${e.command}\` exit 0 (${e.lastLine || "no output"})` : "";
    const evidence = d.evidence ? `, evidence: "${d.evidence}"` : "";
    return `${d.key} ${d.done ? "[x]" : "[ ]"}${!d.done && blockedIn(report, d.key) ? " reported blocked" : ""}${evidence}${run}`;
  });
  const unnamed = changed.filter((f) => !allNamed.some((n) => covers(n, f)));
  const untouched = ticked.filter((d) => named.get(d.key).length && !named.get(d.key).some((n) => changed.some((f) => covers(n, f))));
  const nameless = ticked.filter((d) => !named.get(d.key).length);
  const untested = ticked.filter((d) => !named.get(d.key).some((n) => TEST_FILE.test(n) && changed.some((f) => covers(n, f))));

  const diff = git("diff", base, "--", ".", ...EXCLUDE).toString("utf8");
  const deletions = new Map();
  const skips = [];
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("--- ")) continue;
    else if (file && TEST_FILE.test(file) && line.startsWith("-") && line.slice(1).trim()) deletions.set(file, (deletions.get(file) ?? 0) + 1);
    else if (file && line.startsWith("+") && SKIP_MARKER.test(line)) skips.push(`${file}: ${line.slice(1).trim().slice(0, 80)}`);
  }
  for (const f of untracked.filter((f) => TEST_FILE.test(f))) {
    for (const line of readFileSync(join(ROOT, f), "utf8").split("\n")) if (SKIP_MARKER.test(line)) skips.push(`${f}: ${line.trim().slice(0, 80)}`);
  }
  const list = (xs, fmt = (x) => x) => (xs.length ? xs.map(fmt).join(", ") : "none");
  const withFiles = (d) => `${d.key} (${named.get(d.key).join(", ")})`;
  return [
    `Items, evidence and recorded test runs: ${list(status)}`,
    `Files changed in this stage: ${list(changed)}`,
    `Changed files that no DEV item names: ${list(unnamed)}. Judge whether each belongs to the plan.`,
    `Ticked DEV items none of whose named files changed: ${list(untouched, withFiles)}. Check that they were really done.`,
    `Ticked DEV items that name no files: ${list(nameless, (d) => d.key)}.`,
    `Ticked DEV items with no named test file added or changed: ${list(untested, (d) => d.key)}.`,
    `Items ticked as needing no change: ${list([...items, ...fixes].filter((d) => d.done && ledger.get(d.key)?.noChange), (d) => `${d.key} (${ledger.get(d.key).evidence})`)}. Judge whether each reason holds.`,
    `Lines deleted from test files: ${list([...deletions], ([f, n]) => `${f} (${n})`)}. Check that no test was weakened.`,
    `Skip markers added: ${list(skips)}.`,
  ].join("\n  ");
}

// `tick <run> <DEV-001|FIX-001> --evidence "<what was done, and where>" -- <command> <args...>`:
// run by STARK, inside its own sandbox, during its call. No evidence, no tick: the evidence must
// name a file this stage changed.
function cmdTick(runDir, args) {
  const state = load(runDir);
  const call = state.inflight;
  if (call?.stage !== "dev" || call.mode !== "work") fail("tick is for STARK, during a development call");
  const item = String(args[0] ?? "");
  const sep = args.indexOf("--");
  const head = sep >= 0 ? args.slice(0, sep) : args;
  const option = (name) => (head.includes(name) ? String(head[head.indexOf(name) + 1] ?? "").trim() : "");
  const evidence = option("--evidence");
  const noChange = option("--no-change");
  // The command runs as the argv given, with no shell, so "|| true" or "; exit 0" cannot turn a
  // failure into a tick, and quoted arguments reach the test runner intact.
  const argv = sep >= 0 ? args.slice(sep + 1) : [];
  if (!/^(DEV|FIX)-\d{3,}$/.test(item) || !argv.length || !evidence === !noChange) {
    fail('usage: tick <run> <DEV-001|FIX-001> (--evidence "<what was done, and where>" | --no-change "<why the item needs no change>") -- <command> <args...>');
  }
  const prefix = item.split("-")[0];
  const d = (prefix === "DEV" ? parseItems(readRunFile(runDir, TODO_DEV), "DEV").items : fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle)).find((x) => x.key === item);
  if (!d) fail(prefix === "DEV" ? `${item} is not an item in the TODO section of todo-dev.md` : `${item} is not a recovery item of the current QA cycle in todo-fix.md`);
  // The evidence must name a file changed for this item: since its last tick, since the engine
  // unticked it, since its QA cycle, or since development began, whichever came last.
  const base = itemBase(runDir, state, item);
  const changed = changedSince(state, base.tree);
  const cited = evidence ? changed.filter((f) => namesFile(evidence, f)) : [];
  if (evidence && !cited.length) {
    fail(changed.length
      ? `the evidence must name a file changed for ${item} since ${base.what}. Changed since then: ${changed.join(", ")}`
      : `nothing has changed since ${base.what}. Build ${item} first; if it needs no change at all, tick it with --no-change "<why>" instead (UBEL reviews the reason).`);
  }
  const at = now();
  const command = argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
  const ledger = `${callBase(runDir, call.id)}.ticks.jsonl`;
  const log = `${call.id}.tick-${item}.log`;
  const r = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error?.code === "ENOENT") {
    fail(`command not found: ${argv[0]}. Pass the command and its arguments as separate words after --, not as one quoted string; write sh -c '...' explicitly if you need a shell.`);
  }
  writeFileSync(join(runDir, "calls", log), `$ ${command}\n--- stdout ---\n${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}\n[exit ${r.status}]\n`);
  if (r.status !== 0) {
    print({ action: "not_ticked", item, exitCode: r.status, log: join(runDir, "calls", log), next: "Fix the failure, then run tick again." });
    process.exit(1);
  }
  // Record the test runner's pass/fail summary (e.g. "ℹ pass 10 / ℹ fail 0"), else stdout's last line.
  const out = ((r.stdout ?? "").trim() || (r.stderr ?? "").trim()).split("\n").filter(Boolean);
  const summary = out.filter((l) => /\b(pass(ed|es)?|fail(ed|ures?)?|tests?)\b/i.test(l)).slice(-2).join(" / ");
  const lastLine = (summary || out.at(-1) || "").slice(0, 160);
  const entry = { item, command, evidence: evidence || `No change needed: ${noChange}`, noChange: Boolean(noChange), cited, since: base.what, exitCode: 0, at, lastLine, log, logSha: hashFile(join(runDir, "calls", log)) };
  appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
  print({ action: "ticked", item, lastLine, next: `Recorded. The engine writes the tick and its evidence into ${prefix === "DEV" ? TODO_DEV : TODO_FIX} when this call ends. Go on to the next item.` });
}

// ---------- the work record (ai-log)
// Every run keeps a human-readable record in the project, written by the engine as the run goes:
//   ai-log/<YYYYMMDD>/<NNN>_<HHMMSS>_<name>/
//     00-request/      request.md: DENKEN's summary of the conversation (the raw conversation is in raw/)
//     01-planning/     METHODE <-> RICHTER, one numbered file per step
//     02-development/  STARK <-> UBEL, including recovery rounds after QA failures
//     03-qa/           GENAU's report and evidence, one folder per QA cycle
//     04-wiki/         SERIE <-> FRIEREN
//     raw/             every call's prompt, streamed log and output, as exchanged
//     timeline.md      every step, verdict, stop and resume, in order
//     verdicts.md      every submission and verdict exchanged, in the words it was given
const STAGE_LOG = { plan: "01-planning", dev: "02-development", qa: "03-qa", wiki: "04-wiki" };
const LOG_DIRS = ["00-request", ...Object.values(STAGE_LOG), "raw"];
const clock = () => new Date().toTimeString().slice(0, 8);
const pad = (n, width) => String(n).padStart(width, "0");
const oneLine = (text, max = 200) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
// A unit's run keeps the parent's record, by absolute path, and writes into a folder of its own
// within each part of it: 01-planning/UNIT-1/, raw/UNIT-1/, and so on.
const logDir = (state) => (state.log ? resolve(ROOT, state.log) : null);
const logPart = (state, part) => (state.unit ? join(part, state.unit) : part);

function createLog(name) {
  const d = new Date();
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
  const ignore = join(ROOT, "ai-log", ".gitignore");
  mkdirSync(join(ROOT, "ai-log"), { recursive: true });
  // Raw exchanges and QA evidence can hold secrets (environment dumps, tokens in logs): kept out of
  // git unless the team decides otherwise.
  if (!existsSync(ignore)) writeFileSync(ignore, "*/*/raw/\n*/*/03-qa/*/evidence/\n");
  const dayDir = join(ROOT, "ai-log", day);
  mkdirSync(dayDir, { recursive: true });
  const seq = Math.max(0, ...readdirSync(dayDir).map((f) => Number(f.match(/^(\d{3})_/)?.[1] ?? 0))) + 1;
  const title = String(name).normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "run";
  const dir = join(dayDir, `${pad(seq, 3)}_${d.toTimeString().slice(0, 8).replace(/:/g, "")}_${title}`);
  for (const sub of LOG_DIRS) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "timeline.md"), `# Timeline: ${name}\n\nEvery step, verdict, stop and resume of this run, in order.\n\n`);
  writeFileSync(join(dir, "verdicts.md"), VERDICTS_HEAD(name));
  return relative(ROOT, dir);
}

function timeline(state, actor, text) {
  const dir = logDir(state);
  if (dir) appendFileSync(join(dir, "timeline.md"), `- ${clock()} · **${state.unit ? `${state.unit} · ` : ""}${actor}** · ${text}\n`);
}

// verdicts.md: one line per submission or verdict, with the words it was given in. The lines live
// in state.json and the file is rewritten from them on every entry, so the engine is its only
// writer: a copy changed by anyone else is kept in raw/, noted, and replaced.
const STAGE_NAME = { plan: "Planning", dev: "Development", wiki: "Docs" };
const VERDICTS_HEAD = (task) => `# Verdicts: ${task}\n\nEvery submission and verdict exchanged in this run, in order, in the words it was given. Each line links the step file that holds the full text. The engine alone writes this file.\n\n`;
function verdict(state, label, who, word, text, { call = null, file = null, note = null } = {}) {
  const dir = logDir(state);
  if (!dir) return;
  const full = String(text ?? "").replace(/\s+/g, " ").trim();
  const shown = oneLine(full, 1000);
  writeVerdicts(state, `- ${clock()} · ${label} · ${who}${call ? ` · ${call}` : ""} · **${word}**${note ? ` (${note})` : ""} · ${shown}${shown.length < full.length ? " … (truncated)" : ""}${file ? ` → ${file}` : ""}`);
}
function writeVerdicts(state, line) {
  state.verdicts ??= [];
  // A unit's lines are pulled into the parent's verdicts.md by the parent, the file's only writer.
  if (state.unit) return state.verdicts.push(line);
  const path = join(logDir(state), "verdicts.md");
  if (state.verdictsSha && hashFile(path) !== state.verdictsSha) {
    const kept = `raw/verdicts.changed-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.md`;
    if (existsSync(path)) copyFileSync(path, join(logDir(state), kept));
    state.verdicts.push(`- ${clock()} · Record · ENGINE · **RESTORED** · verdicts.md was changed outside the engine; it was rewritten from the engine's own record, and the changed copy kept → ${kept}`);
    timeline(state, "ENGINE", `verdicts.md was changed outside the engine: restored, changed copy kept → ${kept}`);
  }
  state.verdicts.push(line);
  const content = `${VERDICTS_HEAD(state.task)}${state.verdicts.join("\n")}\n`;
  writeFileSync(path, content);
  state.verdictsSha = sha(content);
}

// One numbered file per step in a stage folder; returns its path within the log.
function logStep(state, stage, name, content) {
  const dir = logDir(state);
  if (!dir) return null;
  const part = logPart(state, STAGE_LOG[stage]);
  const folder = join(dir, part);
  mkdirSync(folder, { recursive: true });
  const n = readdirSync(folder).filter((f) => /^\d{2}_/.test(f)).length + 1;
  const file = `${pad(n, 2)}_${name}.md`;
  writeFileSync(join(folder, file), content);
  return `${part}/${file}`;
}

// Copies everything a call exchanged (prompt, job, streamed log, output, gaps, ticks, ...) to raw/.
function logRaw(state, runDir, callId) {
  const dir = logDir(state);
  if (!dir) return;
  state.rawSeq = (state.rawSeq ?? 0) + 1;
  const raw = join(dir, logPart(state, "raw"));
  mkdirSync(raw, { recursive: true });
  for (const f of readdirSync(join(runDir, "calls"))) {
    const path = join(runDir, "calls", f);
    if (!f.startsWith(`${callId}.`)) continue;
    if (statSync(path).isFile()) copyFileSync(path, join(raw, `${pad(state.rawSeq, 3)}_${f}`));
    else if (f.endsWith(".tampered")) for (const t of listFiles(path)) {
      const target = join(raw, `${pad(state.rawSeq, 3)}_${f}`, relative(path, t));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(t, target);
    }
  }
}

// 00-request/request.md is DENKEN's request.md as it stands; the conversation it came from is kept
// verbatim in raw/.
function logRequest(state, runDir) {
  const dir = logDir(state);
  if (!dir) return;
  mkdirSync(join(dir, logPart(state, "00-request")), { recursive: true });
  copyFileSync(join(runDir, REQUEST), join(dir, logPart(state, "00-request"), "request.md"));
  if (existsSync(join(runDir, UNITS)) && !state.unit) copyFileSync(join(runDir, UNITS), join(dir, "00-request", UNITS));
  if (existsSync(join(runDir, "conversation.md"))) copyFileSync(join(runDir, "conversation.md"), join(dir, "raw", "000_conversation.md"));
}

function renderFindings(title, review, { word = null, note = null } = {}) {
  const blocking = review.findings.filter((f) => f.severity === "blocking");
  const nonblocking = review.findings.filter((f) => f.severity === "nonblocking");
  const item = (f, i) => `${i + 1}. [${f.topic}]${f.file ? ` ${f.file}${f.line_start ? `:${f.line_start}` : ""}` : ""}${f.request_item ? ` (${f.request_item})` : ""}${f.todo ? ` (${f.todo})` : ""}: ${f.problem}\n   Required change: ${f.required_change}`;
  return [
    `# ${title}`,
    "",
    `Verdict: **${word ?? (blocking.length ? "REJECTED" : "APPROVED")}**${note ? ` (${note})` : ""}`,
    "",
    ...(review.summary ? [`> ${String(review.summary).trim().replace(/\n/g, "\n> ")}`, ""] : []),
    "## Blocking findings",
    "",
    blocking.map(item).join("\n") || "None.",
    "",
    "## Nonblocking findings",
    "",
    nonblocking.map(item).join("\n") || "None.",
    "",
    "## What was checked (the basis for the verdict)",
    "",
    (review.checked ?? []).map((c) => `- ${c}`).join("\n") || "- (not stated)",
    "",
  ].join("\n");
}

function renderFacts(facts) {
  if (!facts) return "";
  const rows = [
    ["Provider", `${facts.provider}${facts.model ? ` · ${facts.model}` : ""}${facts.effort ? ` · effort ${facts.effort}` : ""}`],
    ["CLI", facts.cliVersion],
    ["Session", facts.sessionId],
    ["Exit", facts.exitCode],
    ["Duration", facts.durationSec != null ? `${facts.durationSec}s` : null],
    ["Cost", facts.costUsd != null ? `$${facts.costUsd.toFixed(4)}` : null],
    ["Tokens", facts.tokens ? `in ${facts.tokens.input ?? "?"} · out ${facts.tokens.output ?? "?"} · cache read ${facts.tokens.cacheRead ?? "?"}` : null],
    ["HEAD", facts.head],
    ["Stage base", facts.stageBase],
    ["Grants", facts.grants ? JSON.stringify(facts.grants) : null],
  ].filter(([, v]) => v != null && v !== "");
  return `\n## Call facts\n\n${rows.map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`;
}
const factsBrief = (facts) => (facts ? ` (${[facts.durationSec != null && `${facts.durationSec}s`, facts.costUsd != null && `$${facts.costUsd.toFixed(2)}`].filter(Boolean).join(", ") || facts.provider})` : "");

function renderWork(runDir, state, call, provider, facts) {
  const parts = [`# ${call.role.toUpperCase()} · ${call.stage} round ${call.round}${call.attempt > 1 ? `, attempt ${call.attempt}` : ""} · ${provider}`, "", "## Final message", "", readRunFile(runDir, `calls/${call.id}.out.md`).trim() || "(none)"];
  for (const f of ARTIFACTS[call.stage]) parts.push("", `## ${f}`, "", readRunFile(runDir, f).trim() || "(empty)");
  if (call.stage === "dev") {
    parts.push("", "## todo-dev.md (as ticked, with evidence)", "", readRunFile(runDir, TODO_DEV).trim());
    if (existsSync(join(runDir, TODO_FIX))) parts.push("", "## todo-fix.md", "", readRunFile(runDir, TODO_FIX).trim());
    const ticks = readRunFile(runDir, `calls/${call.id}.ticks.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    parts.push("", "## Items ticked in this round", "", ticks.map((t) => `- ${t.item}: \`${t.command}\` exit 0 (${t.lastLine || "no output"})\n  Evidence: ${t.evidence}`).join("\n") || "None.");
    parts.push("", "## Files changed since development began", "", stageChanges(state, "dev").changed.map((f) => `- ${f}`).join("\n") || "None.");
  }
  if (call.stage === "wiki") parts.push("", "## Docs changed in this stage", "", stageChanges(state, "wiki").changed.map((f) => `- ${f}`).join("\n") || "None.");
  return `${parts.join("\n")}\n${renderFacts(facts)}`;
}

function logQa(state, runDir, call, items, facts) {
  const dir = logDir(state);
  if (!dir) return;
  const folder = join(dir, logPart(state, STAGE_LOG.qa), `qa-${call.round}`);
  mkdirSync(join(folder, "evidence"), { recursive: true });
  const evidence = join(runDir, "calls", `${call.id}.evidence`);
  if (existsSync(evidence)) for (const f of listFiles(evidence)) {
    const target = join(folder, "evidence", relative(evidence, f));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(f, target);
  }
  const cell = (t) => oneLine(t, 300).replace(/\|/g, "\\|");
  const rows = items.map((c) => `| ${c.id} | ${c.request_item ?? ""} | ${c.result} | ${cell(c.check)} | ${cell(c.how_verified)} | ${cell(c.evidence)} | ${(c.evidence_files ?? []).map((f) => `\`${basename(f)}\``).join(", ")} |`);
  writeFileSync(join(folder, "report.md"), `# QA cycle ${call.round} · GENAU · ${call.provider}\n\nResult: **${items.every((c) => c.result === "PASS") ? "PASS" : "FAIL"}**\n\n| Item | Request | Result | Check | How verified | Evidence | Files |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n${renderFacts(facts)}`);
}

// Likely secrets in the record, reported by file, line and kind (never the value itself).
const SECRET_PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["credential assignment", /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-\/+=]{16,}/i],
];
function scanSecrets(state) {
  const dir = logDir(state);
  if (!dir) return [];
  const hits = [];
  for (const file of listFiles(dir)) {
    let text;
    try {
      if (statSync(file).size > 20 << 20) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      for (const [kind, re] of SECRET_PATTERNS) if (re.test(line)) hits.push({ file: relative(ROOT, file), line: i + 1, kind });
    });
  }
  return hits;
}

// Stops are logged once, when the run first blocks on them.
function logStop(state) {
  const b = state.blocked;
  if (!b || state.loggedBlock === b.since) return;
  state.loggedBlock = b.since;
  const detail = [
    b.requests?.length ? b.requests.map((r) => `${r.need} (${r.why})`).join("; ") : null,
    b.identity ?? (b.identities ? b.identities.join(", ") : null),
    b.items ? b.items.map((i) => i.item).join(", ") : null,
    b.violations ? b.violations.join("; ") : null,
    b.error ? oneLine(b.error) : null,
    b.rule ?? null,
  ].filter(Boolean).join(" · ");
  const who = { ruling: "DENKEN is called in", permission: "DENKEN is called in to decide a permission", user: "waiting for the user" }[b.kind];
  timeline(state, "STOP", `${b.reason}${detail ? `: ${detail}` : ""} (${who})`);
}

// ---------- prompts

function knownTopics(state, stage) {
  const seen = new Map();
  for (const f of state.findings[stage] ?? []) seen.set(f.identity, { identity: f.identity, topic: f.topic, file: f.file, request_item: f.request_item, raised: state.counts[stage]?.[f.identity] ?? 0 });
  return [...seen.values()];
}

function buildCall(runDir, state, call) {
  const p = (f) => join(runDir, f);
  const read = [];
  const write = [];
  const frozen = call.mode !== "work" || call.stage === "plan";
  const guard = { frozen, ignored: call.mode === "qa" ? "env" : frozen ? "all" : "none", allow: [] };
  const extra = [];
  const lastReview = state.lastReview[call.stage];

  // Who reads what is deliberate: STARK builds from the development TODO alone, GENAU tests
  // from the request and the QA TODO, and every reviewer judges against the request.
  if (call.mode === "work") {
    if (call.stage === "plan") read.push(p(REQUEST));
    if (call.stage === "dev") read.push(p(TODO_DEV));
    if (call.stage === "wiki") read.push(p(REQUEST), p(TODO_DEV), p("dev-report.md"), state.lastQa);
    if (call.stage === "dev" && state.devInput === "qa") read.push(p(TODO_FIX));
    else if (call.round > 1 && lastReview) read.push(lastReview);
    write.push(...ARTIFACTS[call.stage].map(p));
    guard.allow.push(...ARTIFACTS[call.stage]);
    if (call.stage === "plan") extra.push(`Do not change any project file. Write only ${TODO_DEV} and ${TODO_QA}.`);
    if (call.stage === "wiki") {
      const docs = relatedDocs(state.runChanges ?? [], state.runDeleted ?? []);
      const must = docs.filter((d) => d.mustUpdate);
      extra.push(`Files changed in this run: ${(state.runChanges ?? []).join(", ") || "none"}${state.runDeleted?.length ? ` (deleted: ${state.runDeleted.join(", ")})` : ""}.\n  Existing docs that mention them: ${docs.map((d) => `${d.doc} (${d.mentions.join(", ")})`).join("; ") || "none"}.${must.length ? `\n  Must update, because they mention files this run deleted: ${must.map((d) => d.doc).join(", ")}.` : ""}\n  Update only the documentation these changes affect: those docs, or a new page under docs/ when no existing page covers them. Leave unrelated pages alone, change no file that is not documentation, and do not touch agent configuration (CLAUDE.md, AGENTS.md, .claude/, .codex/, .agents/).`);
    }
    if (call.stage === "dev") {
      extra.push(`When an item is built, tick it off through the engine: node "${SCRIPT}" tick "${runDir}" <DEV-001|FIX-001> --evidence "<what was done, and where: name the files>" -- <command> <args...> (for example: -- node --test test/a.test.js). The command runs as given, without a shell. The tick is recorded only if the command passes and the evidence names a file changed for that item (since its last tick, or since development began). For an item that truly needs no change, pass --no-change "<why>" instead of --evidence. The engine writes the ticks and evidence into ${TODO_DEV} and ${TODO_FIX} when your call ends; do not edit those files.`);
      if (state.devInput === "qa") {
        const fixes = fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle).map((f) => f.key);
        extra.push(`This round fixes what independent QA found: the recovery items ${fixes.join(", ")} under "QA cycle ${state.currentFixCycle}" in ${TODO_FIX}. Fix each cause in general, re-tick the DEV items the engine unticked, and tick each FIX item off with a test that reproduces its failure.`);
      }
    }
  } else if (call.mode === "review") {
    read.push(p(REQUEST));
    if (call.stage === "dev") read.push(p(TODO_DEV));
    read.push(...ARTIFACTS[call.stage].map(p));
    if (call.stage !== "plan") {
      const diffPath = `${callBase(runDir, call.id)}.diff`;
      const base = state.stageBase[call.stage] || EMPTY_TREE;
      writeFileSync(diffPath, Buffer.concat([git("diff", base, "--", ".", ...EXCLUDE), Buffer.from("\n# Untracked files (read them directly)\n"), git("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE)]));
      read.push(diffPath);
    }
    if (lastReview) read.push(lastReview);
    if (call.stage === "dev") extra.push(`Scope facts computed by the engine:\n  ${scopeReport(runDir, state)}`);
    if (call.stage === "dev" && state.devInput === "merge") {
      extra.push(`This is the merged result of units built in parallel, each already reviewed on its own: ${state.units.map((u) => `${u.id} "${u.title}" (${u.reqs.join(", ")}, in ${u.scope.join(", ")})`).join("; ")}. Review what no unit's reviewer could see: how the units fit together. Look for duplicated helpers, inconsistent names or APIs, conflicting assumptions, and a change in one unit that breaks another.`);
    }
    if (call.stage === "wiki") {
      extra.push(`Code changed in this run: ${(state.runChanges ?? []).filter((f) => !isDoc(f)).join(", ") || "none"}.\n  Docs changed in this stage: ${stageChanges(state, "wiki").changed.join(", ") || "none"}.\n  Read the code each changed doc describes, and check that the description matches it. Flag docs changed for no reason related to these changes.`);
    }
    if (call.stage === "dev" && state.devInput === "qa") {
      read.push(p(TODO_FIX));
      extra.push(`This round fixes what independent QA found (QA cycle ${state.currentFixCycle} in ${TODO_FIX}). Check that each fix is general: no special-casing of the reported inputs, no hard-coded expected outputs, no weakened or deleted tests.`);
    }
    const topics = knownTopics(state, call.stage);
    if (topics.length) extra.push(`Known topics in this stage. For the same issue, reuse the same topic, file and request_item:\n${topics.map((t) => `  - ${t.identity} (topic "${t.topic}", file ${t.file ?? "none"}, request_item ${t.request_item ?? "none"}, raised ${t.raised}x)`).join("\n")}`);
    const dismissed = state.dismissed[call.stage] ?? [];
    if (dismissed.length) extra.push(`Dismissed by DENKEN. Do not raise these again: ${dismissed.join(", ")}`);
    const denials = state.lastWork[call.stage]?.denials ?? [];
    if (denials.length) extra.push(`The worker had ${denials.length} action(s) blocked by permissions in its last call. Check that nothing the work depends on was skipped:\n${denials.map((d) => `  - ${d.tool}: ${JSON.stringify(d.input).slice(0, 200)}`).join("\n")}`);
  } else {
    read.push(p(REQUEST), p(TODO_QA));
    if (state.units) extra.push(`This is the check after the merge: ${state.units.map((u) => u.id).join(", ")} were built in parallel, each verified on its own, then merged. Run every item against the merged product, starting with QA-001, the whole test suite.`);
    extra.push(`Save the evidence for each item as files in ${callBase(runDir, call.id)}.evidence/ (command output, logs, and screenshots when there is a UI), and list each item's files in evidence_files.`);
  }
  if (existsSync(p("rulings.md"))) read.push(p("rulings.md"));
  if (call.mode !== "review") {
    extra.push(`If a missing permission stops you (network access, a path outside the project, a blocked command), do not work around it. Ask for it with: node "${SCRIPT}" request-permission "${runDir}" --need "<network | dir:<path> | tool:<pattern> | anything else>" --why "<what it is for>". Then stop and end your turn with a one-line summary; DENKEN decides and runs you again.`);
  }

  const agent = agentFor(state, call);
  // A reviewer's prompt is its stage checklist followed by the rules every reviewer shares.
  const roleFile = (name) => readFileSync(join(SKILL_DIR, "roles", `${name}.md`), "utf8").trimEnd();
  const roleText = call.mode === "review" ? `${roleFile(call.role)}\n\n${roleFile("reviewer")}` : roleFile(call.role);
  const lines = [
    roleText.trimEnd(),
    "",
    "---",
    "",
    "## This call",
    "",
    `- Stage: ${call.stage}, round ${call.round}. You run on ${agent.provider}${agent.model ? ` (${agent.model})` : ""}.`,
    `- Project root: ${ROOT}`,
    ...(state.unit ? [`- Unit: ${state.unit} (${state.title}). Scope: ${state.scope.join(", ")}. This is the unit's own worktree; other units are built in parallel in theirs.`] : []),
    `- Run directory: ${runDir}`,
    `- Read:\n${read.map((f) => `  - ${f}`).join("\n")}`,
  ];
  if (write.length) lines.push(`- Write:\n${write.map((f) => `  - ${f}`).join("\n")}`);
  for (const e of extra) lines.push(`- ${e}`);
  if (call.mode !== "work") lines.push("- Your final message must be JSON that matches the provided schema.");
  return { prompt: `${lines.join("\n")}\n`, guard, agent };
}

function agentFor(state, call) {
  const s = state.assignment.stages[call.stage];
  return call.mode === "qa" ? s.runner : call.mode === "work" ? s.worker : s.reviewer;
}

// ---------- launching and executing calls

function nextCall(state) {
  if (state.retryCall) {
    const c = state.retryCall;
    state.retryCall = null;
    return c;
  }
  const stage = state.stage;
  if (stage === "qa") return { stage, role: "genau", mode: "qa", round: ++state.round.qa, attempt: 1 };
  if (state.pending === "work") return { stage, role: WORKER[stage], mode: "work", round: ++state.round[stage], attempt: 1 };
  return { stage, role: REVIEWER[stage], mode: "review", round: state.round[stage], attempt: 1 };
}

function launch(runDir, state) {
  const call = nextCall(state);
  call.id = `${call.stage}-${call.role}-${call.round}`;
  call.nonce = randomUUID();
  const base = callBase(runDir, call.id);
  const { prompt, guard, agent } = buildCall(runDir, state, call);
  // Keep an earlier attempt's files for debugging, out of the way of the new attempt.
  const stamp = Date.now();
  for (const suffix of [".meta.json", ".pid", ".cli.pid", ".heartbeat", ".out.json", ".out.md", ".log"]) {
    if (existsSync(base + suffix)) renameSync(base + suffix, `${base}.prev-${stamp}${suffix}`);
  }
  writeFileSync(`${base}.prompt.md`, prompt);
  const timeoutMs = Math.round(state.assignment.limits.callTimeoutMin * 60000);
  const grants = call.mode === "review" ? null : state.grants?.[call.role] ?? null;
  if (call.mode === "qa") mkdirSync(`${base}.evidence`, { recursive: true });
  // A unit's record lives in the parent's ai-log, outside the unit's worktree, where siblings
  // write too: the unit's guard covers its worktree, and Claude is denied the main checkout.
  writeFileSync(`${base}.job.json`, JSON.stringify({ ...call, agent: { ...agent, grants }, guard, timeoutMs, log: state.unit ? null : state.log ?? null, protect: state.mainRoot ?? null, stageBase: state.stageBase[call.stage] ?? null }, null, 2));
  state.inflight = { ...call, provider: agent.provider, started: now() };
  timeline(state, `${call.role.toUpperCase()} (${agent.provider})`, `started ${call.stage === "qa" ? `QA cycle ${call.round}` : `${call.stage} round ${call.round}`}${call.attempt > 1 ? `, attempt ${call.attempt}` : ""}`);
  state.calls.push({ id: call.id, mode: call.mode, provider: agent.provider, model: agent.model, attempt: call.attempt, started: state.inflight.started });
  save(runDir, state);
  const child = spawn(process.execPath, [SCRIPT, "_exec", runDir, call.id], { cwd: ROOT, detached: true, stdio: "ignore" });
  writeFileSync(`${base}.pid`, String(child.pid));
  child.unref();
}

function validOutput(mode, value) {
  if (mode === "review") {
    return ["APPROVED", "CHANGES_REQUESTED"].includes(value?.verdict) && Array.isArray(value.findings) &&
      value.findings.every((f) => ["blocking", "nonblocking"].includes(f.severity) && typeof f.topic === "string" && typeof f.problem === "string");
  }
  return ["PASS", "FAIL"].includes(value?.result) && Array.isArray(value.items) && value.items.length > 0 && value.items.every((c) => /^QA-\d{3,}$/.test(c.id) && ["PASS", "FAIL"].includes(c.result));
}

// ---------- process groups
// Each agent CLI leads its own process group, so the test runners, servers and shells it
// starts can be stopped with it. Signals go to the whole group (negative pid).

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

async function stopGroup(pgid) {
  if (!pgid || !signalGroup(pgid, 0)) return;
  signalGroup(pgid, "SIGTERM");
  for (let i = 0; i < 30 && signalGroup(pgid, 0); i++) await sleep(100);
  signalGroup(pgid, "SIGKILL");
}

// Stop a group only if its leader is still the agent CLI we started, never a reused pid.
async function stopCallGroup(base, provider) {
  const pgid = Number(existsSync(`${base}.cli.pid`) ? readFileSync(`${base}.cli.pid`, "utf8") : 0);
  if (!pgid) return;
  const command = spawnSync("ps", ["-o", "command=", "-p", String(pgid)], { encoding: "utf8" }).stdout ?? "";
  if (command.includes(provider)) await stopGroup(pgid);
}

async function runCli(provider, args, input, base, timeoutMs) {
  const logFd = openSync(`${base}.log`, "w");
  const child = spawn(provider, args, { cwd: ROOT, stdio: ["pipe", logFd, logFd], detached: true });
  closeSync(logFd);
  if (child.pid) writeFileSync(`${base}.cli.pid`, String(child.pid));
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopGroup(child.pid);
  }, timeoutMs);
  const result = await new Promise((done) => {
    child.on("error", (error) => done({ status: null, error }));
    child.on("exit", (status, signal) => done({ status, signal }));
  });
  clearTimeout(timer);
  await stopGroup(child.pid);
  return { ...result, timedOut };
}

async function execCall(runDir, id) {
  const base = callBase(runDir, id);
  // A heartbeat lets `next` tell a live call from a dead one even if the pid is reused.
  const beat = () => writeFileSync(`${base}.heartbeat`, now());
  beat();
  const heartbeat = setInterval(beat, 5000);
  const job = JSON.parse(readFileSync(`${base}.job.json`, "utf8"));
  const prompt = readFileSync(`${base}.prompt.md`, "utf8");
  const structured = job.mode !== "work";
  const schemaPath = join(SKILL_DIR, "schemas", `${job.mode}.schema.json`);
  const outPath = `${base}.out.${structured ? "json" : "md"}`;
  const { provider, model, effort } = job.agent;
  // Permissions DENKEN granted to this role on request widen the defaults, never a reviewer's.
  const grants = { network: false, domains: [], dirs: [], tools: [], ...job.agent.grants };
  const network = job.agent.network || grants.network;
  const meta = { status: "ok", nonce: job.nonce, exitCode: null, sessionId: null, denials: [], violations: [], error: null };
  const startedAt = Date.now();
  const facts = { provider, model: model ?? null, effort: effort ?? null, cliVersion: (spawnSync(provider, ["--version"], { encoding: "utf8", timeout: 20000 }).stdout ?? "").trim().split("\n")[0] || null, head: gitText("rev-parse", "-q", "--verify", "HEAD") || null, stageBase: job.stageBase ?? null, grants: job.agent.grants ?? null };
  let errorText = "";

  // Both CLIs stream JSON events; they go straight to the log so `status` can show progress.
  let args;
  if (provider === "claude") {
    meta.sessionId = randomUUID();
    args = ["-p", "--output-format", "stream-json", "--verbose", "--session-id", meta.sessionId];
    // Reviewers and GENAU check other agents' work, so they load no project settings (a worker
    // could have planted hooks there) and no MCP servers.
    if (job.mode !== "work") args.push("--setting-sources", "user", "--strict-mcp-config");
    if (job.mode === "review") args.push("--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk");
    else {
      const sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };
      args.push("--permission-mode", "auto");
      if (!network) {
        // The strict allowlist covers sandboxed commands only; web tools and MCP servers
        // reach the network in-process, so they are removed too.
        sandbox.network = { strictAllowlist: true, allowedDomains: grants.domains ?? [] };
        args.push("--disallowedTools", "WebFetch,WebSearch");
        if (job.mode === "work") args.push("--strict-mcp-config");
      }
      // The sandbox bounds Bash; Claude's own file tools are bounded by permission rules. A unit's
      // agents may not edit the main checkout, which holds the other units' record.
      // "//" makes the rule path absolute; a single "/" would be relative to the settings source.
      const permissions = job.protect ? { deny: ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(/${job.protect}/**)`) } : undefined;
      args.push("--settings", JSON.stringify({ sandbox, ...(permissions ? { permissions } : {}) }));
      for (const dir of grants.dirs) args.push("--add-dir", dir);
      if (grants.tools.length) args.push("--allowedTools", grants.tools.join(","));
    }
    if (structured) args.push("--json-schema", readFileSync(schemaPath, "utf8"));
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
  } else {
    args = ["exec", "--json", "-s", job.mode === "review" ? "read-only" : "workspace-write", "-o", outPath];
    if (network && job.mode !== "review") args.push("-c", "sandbox_workspace_write.network_access=true");
    if (job.mode !== "review") for (const dir of grants.dirs) args.push("--add-dir", dir);
    if (structured) args.push("--output-schema", schemaPath);
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push("-");
  }

  const gitFiles = ["config", "info/exclude"].map((f) => resolve(ROOT, gitText("rev-parse", "--git-path", f)));
  const gitPinned = Object.fromEntries(gitFiles.map((f) => [f, existsSync(f) ? readFileSync(f) : null]));
  const before = snapshot(runDir, id, job.log);
  const pinned = pinOwned(before.owned);
  const result = await runCli(provider, args, prompt, base, job.timeoutMs);
  // Git's own config could make the engine's next git command run a program (fsmonitor, filters),
  // and info/exclude could hide new files from the guard. Undo any change before using git again.
  const gitViolations = [];
  for (const f of gitFiles) {
    const current = existsSync(f) ? readFileSync(f) : null;
    if ((current === null) !== (gitPinned[f] === null) || (current && !current.equals(gitPinned[f]))) {
      const kept = join(runDir, "calls", `${id}.tampered`, "git", relative(resolve(ROOT, ".git"), f).replace(/^(\.\.\/)+/, ""));
      if (current) {
        mkdirSync(dirname(kept), { recursive: true });
        writeFileSync(kept, current);
      }
      if (gitPinned[f] === null) rmSync(f, { force: true });
      else writeFileSync(f, gitPinned[f]);
      gitViolations.push(`git file changed: ${relative(ROOT, f)} (restored)`);
    }
  }

  const events = [];
  for (const line of readFileSync(`${base}.log`, "utf8").split("\n")) {
    if (!line.startsWith("{")) {
      if (line.trim()) errorText += `${line}\n`;
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  if (provider === "claude") {
    const final = events.findLast((e) => e.type === "result");
    if (final) {
      meta.denials = (final.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: d.tool_input }));
      if (final.is_error) {
        meta.error = `claude reported an error: ${final.subtype ?? ""} ${final.api_error_status ?? ""}`.trim();
        errorText += `${final.result ?? ""} ${final.api_error_status ?? ""}\n`;
      }
      const output = structured ? final.structured_output : final.result;
      if (output != null) writeFileSync(outPath, structured ? JSON.stringify(output, null, 2) : String(output));
      facts.costUsd = final.total_cost_usd ?? null;
      facts.tokens = final.usage ? { input: final.usage.input_tokens ?? null, output: final.usage.output_tokens ?? null, cacheRead: final.usage.cache_read_input_tokens ?? null } : null;
      facts.turns = final.num_turns ?? null;
    }
  } else {
    for (const event of events) {
      if (event.type === "thread.started") meta.sessionId = event.thread_id;
      if (event.type === "error" || event.type === "turn.failed") errorText += `${JSON.stringify(event)}\n`;
      if (event.type === "turn.completed" && event.usage) {
        facts.tokens ??= { input: 0, output: 0, cacheRead: 0 };
        facts.tokens.input += event.usage.input_tokens ?? 0;
        facts.tokens.output += event.usage.output_tokens ?? 0;
        facts.tokens.cacheRead += event.usage.cached_input_tokens ?? 0;
      }
    }
  }
  meta.exitCode = result.status;
  if (result.timedOut) meta.error = `timed out after ${Math.round(job.timeoutMs / 60000)} min`;
  else if (result.error) meta.error = result.error.message;

  meta.violations = [...gitViolations, ...violations(before, snapshot(runDir, id, job.log), job.guard, runDir, pinned, id)];
  const output = existsSync(outPath) ? readFileSync(outPath, "utf8").trim() : "";
  if (meta.violations.length) meta.status = "guard_violation";
  else if (result.timedOut) meta.status = "timeout";
  else if (result.status !== 0 || meta.error) {
    meta.status = USAGE_LIMIT.test(errorText) ? "usage_limit" : "failed";
    meta.error ??= `${provider} exited with ${result.status}`;
  } else if (!output) {
    meta.status = "failed";
    meta.error = "the agent produced no final message";
  } else if (structured) {
    let value = null;
    try {
      value = JSON.parse(output);
    } catch {}
    const qIds = new Set(parseItems(readRunFile(runDir, TODO_QA), "QA").items.map((q) => q.key));
    const unknown = job.mode === "qa" && validOutput("qa", value) ? value.items.filter((c) => !qIds.has(c.id)).map((c) => c.id) : [];
    if (!validOutput(job.mode, value)) {
      meta.status = "invalid_output";
      meta.error = "the final message does not match the schema";
    } else if (unknown.length) {
      meta.status = "invalid_output";
      meta.error = `the QA report has items that are not in todo-qa.md: ${unknown.join(", ")}`;
    }
  }
  meta.finished = now();
  meta.facts = { ...facts, sessionId: meta.sessionId, exitCode: meta.exitCode, durationSec: Math.round((Date.now() - startedAt) / 1000) };
  clearInterval(heartbeat);
  writeMeta(base, meta);
}

// The result file is the signal that a call finished, so it is written atomically: `next`
// must never read a half-written one.
function writeMeta(base, meta) {
  writeFileSync(`${base}.meta.json.tmp`, JSON.stringify(meta, null, 2));
  renameSync(`${base}.meta.json.tmp`, `${base}.meta.json`);
}

// ---------- ingesting results

function enterStage(state, stage) {
  state.stage = stage;
  state.pending = "work";
  // What this run changed, from the start of development to the end of QA: the wiki stage
  // documents exactly this.
  if (stage === "wiki") {
    state.runChanges = stageChanges(state, "dev").changed;
    state.runDeleted = gitText("diff", "--name-only", "--diff-filter=D", state.stageBase.dev || EMPTY_TREE, "--", ".", ...EXCLUDE).split("\n").filter(Boolean);
  }
  if (stage === "dev" || stage === "wiki") {
    state.stageBase[stage] = gitText("stash", "create") || gitText("rev-parse", "-q", "--verify", "HEAD") || EMPTY_TREE;
    (state.stageEnteredAt ??= {})[stage] = now();
    (state.untrackedAtStage ??= {})[stage] = gitText("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE).split("\n").filter(Boolean);
  }
}

// The last verdict, and the digest of the finished verdicts.md, kept in the timeline and state.
function finish(state) {
  if (state.unit) return verdict(state, "Unit", "ENGINE", "DONE", "planned, built, reviewed and verified on its own; it is merged when every unit is done");
  verdict(state, "Done", "ENGINE", "DONE", "every stage approved");
  timeline(state, "ENGINE", `verdicts.md sha256: ${state.verdictsSha}`);
}
// A unit ends with its own QA: the docs are written once, for the merged result.
const nextStageOf = (state, stage) => (state.unit && stage === "qa" ? "done" : NEXT_STAGE[stage]);

function approve(state, stage, evidence) {
  state.approved[stage] = evidence;
  const next = nextStageOf(state, stage);
  // The record is tracked in the project, so likely secrets in it stop the run before DONE.
  if (next === "done" && !state.unit) {
    state.secretFindings = scanSecrets(state);
    if (state.secretFindings.length) {
      timeline(state, "ENGINE", `secret scan: ${state.secretFindings.length} possible secret(s) in the record (${[...new Set(state.secretFindings.map((h) => h.file))].slice(0, 5).join(", ")})`);
      return block(state, "user", { reason: "secrets_in_record", resolveWith: "secrets", stage, findings: state.secretFindings });
    }
  }
  timeline(state, "ENGINE", next === "done" ? (state.unit ? "DONE: planned, built, reviewed and verified; waiting for the merge" : "DONE: every stage approved") : `${stage} approved → ${next}`);
  if (next === "done") finish(state);
  if (stage === "dev") state.devInput = null;
  enterStage(state, next);
  // Development starts only after the user has confirmed the scope and both TODO lists.
  if (stage === "plan") block(state, "user", { reason: "confirm_todos", resolveWith: "confirm", stage: "plan" });
}

const fileOf = (f) => (f.file ? String(f.file).replace(/:\d+.*$/, "") : null);
const tokens = (text) => new Set(slug(text).split("-").filter(Boolean));

// A finding's identity decides what counts as "the same topic". A request item wins; otherwise
// file plus topic, where a slightly renamed topic on the same file (token Jaccard >= 0.5)
// is merged into the known identity.
function identityOf(f, known) {
  if (f.identity) return f.identity;
  if (typeof f.request_item === "string" && /^REQ-\d{3,}$/.test(f.request_item)) return f.request_item;
  const file = fileOf(f);
  const mine = tokens(f.topic);
  for (const k of known) {
    if (k.request_item || fileOf(k) !== file) continue;
    const theirs = tokens(k.topic);
    const shared = [...mine].filter((t) => theirs.has(t)).length;
    if (shared / (mine.size + theirs.size - shared) >= 0.5) return k.identity;
  }
  return file ? `${file}::${slug(f.topic)}` : slug(f.topic);
}

function block(state, kind, details) {
  state.blocked = { kind, since: now(), ...details };
}

function checkThresholds(state, stage) {
  const { topicRepeats, roundsPerStage } = state.assignment.limits;
  const repeated = Object.entries(state.counts[stage] ?? {}).find(([, n]) => n >= topicRepeats);
  if (repeated) {
    const [identity] = repeated;
    const occurrences = (state.findings[stage] ?? []).filter((f) => f.identity === identity);
    if ((state.ruled[stage] ?? []).includes(identity)) {
      return block(state, "user", { reason: "topic_repeated_after_ruling", resolveWith: "rule", stage, identity, occurrences, count: repeated[1], limit: topicRepeats });
    }
    return block(state, "ruling", { reason: "topic_repeated", stage, identity, occurrences, count: repeated[1], limit: topicRepeats, rule: `raised ${repeated[1]} times (limit ${topicRepeats})` });
  }
  const history = state.history[stage].slice(state.historyBase[stage] ?? 0);
  const last = history.slice(-3).map((h) => h.blocking);
  if (last.length === 3 && last[0] > 0 && last[2] >= last[1] && last[1] >= last[0]) {
    return block(state, "ruling", { reason: "stalled", stage, blockingPerRound: last, rule: `blocking findings per round ${last.join(" → ")}, not going down` });
  }
  if (state.round[stage] - (state.capBase[stage] ?? 0) >= roundsPerStage) {
    return block(state, "ruling", { reason: "round_cap", stage, rounds: state.round[stage], limit: roundsPerStage, rule: `${state.round[stage] - (state.capBase[stage] ?? 0)} rounds (limit ${roundsPerStage})` });
  }
}

function ingest(runDir, state, meta) {
  const call = state.inflight;
  state.inflight = null;
  const record = state.calls.findLast((c) => c.id === call.id);
  Object.assign(record, { status: meta.status, exitCode: meta.exitCode, sessionId: meta.sessionId, finished: meta.finished ?? now(), denials: meta.denials?.length ?? 0 });
  const base = callBase(runDir, call.id);
  const who = call.role.toUpperCase();
  logRaw(state, runDir, call.id);
  if (meta.status !== "ok") timeline(state, who, `${meta.status}${meta.error ? `: ${oneLine(meta.error)}` : ""}${meta.violations?.length ? `: ${meta.violations.join("; ")}` : ""}`);

  if (meta.status === "guard_violation") return block(state, "user", { reason: "guard_violation", resolveWith: "retry", call: call.id, violations: meta.violations });
  // A worker that asked for a permission stops here, whatever it produced: only DENKEN may widen
  // what a role can do, and the call runs again once DENKEN has decided.
  const requests = readRunFile(runDir, `calls/${call.id}.permission.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.attempt === call.attempt);
  for (const r of requests) timeline(state, who, `asked for permission: ${r.need} (${r.why})`);
  if (requests.length) {
    // Requests are capped, and a need DENKEN already denied for this role is denied again
    // without stopping the run, so a worker cannot stall it by asking over and over.
    const asks = ((state.permissionAsks ??= {})[call.role] = (state.permissionAsks[call.role] ?? 0) + 1);
    const denied = new Set((state.permissionDecisions ?? []).filter((d) => d.role === call.role && d.decision === "deny").flatMap((d) => d.requests.map((r) => r.need)));
    if (asks > PERMISSION_ASKS_PER_ROLE || call.attempt >= PERMISSION_ATTEMPTS_PER_CALL) {
      return block(state, "permission", { reason: "permission_loop", resolveWith: "grant", userRequired: true, call: call.id, callInfo: call, role: call.role, provider: call.provider, requests, asks, limit: { perRole: PERMISSION_ASKS_PER_ROLE, attemptsPerCall: PERMISSION_ATTEMPTS_PER_CALL }, denials: meta.denials ?? [] });
    }
    if (requests.every((r) => denied.has(r.need))) {
      const id = `P${(state.permissionDecisions ?? []).length + 1}`;
      const note = `Asked again for ${requests.map((r) => r.need).join(", ")}, which DENKEN already denied for this role. It stays denied: do the work without it, or report the item blocked.`;
      (state.permissionDecisions ??= []).push({ id, call: call.id, role: call.role, decision: "deny", by: "engine", what: requests.map((r) => r.need).join(", "), note, requests, at: now() });
      appendFileSync(join(runDir, "rulings.md"), `${existsSync(join(runDir, "rulings.md")) ? "" : "# Rulings\n\n"}## ${id} · permission · ${who} · denied again (engine)\n\n${note}\n\n`);
      timeline(state, "ENGINE", `${id}: ${who} asked again for ${requests.map((r) => r.need).join(", ")}, already denied → denied again, ${call.id} runs again`);
      state.retryCall = { stage: call.stage, role: call.role, mode: call.mode, round: call.round, attempt: call.attempt + 1 };
      if (call.mode === "work") state.pending = "work";
      return;
    }
    return block(state, "permission", { reason: "needs_permission", resolveWith: "grant", call: call.id, callInfo: call, role: call.role, provider: call.provider, requests, denials: meta.denials ?? [] });
  }
  if (meta.status === "usage_limit") return block(state, "user", { reason: "usage_limit", resolveWith: "retry", call: call.id, provider: call.provider, error: meta.error, log: `${base}.log` });
  if (meta.status !== "ok") {
    if (call.attempt < 2) {
      state.retryCall = { ...call, attempt: call.attempt + 1 };
      delete state.retryCall.provider;
      delete state.retryCall.started;
      return;
    }
    const reason = meta.status === "timeout" ? "call_timeout" : "call_failed";
    return block(state, "user", { reason, resolveWith: "retry", call: call.id, error: meta.error, log: `${base}.log` });
  }

  const stage = call.stage;
  if (call.mode === "work") {
    const missing = ARTIFACTS[stage].filter((f) => !existsSync(join(runDir, f)));
    if (missing.length) {
      meta.status = "failed";
      meta.error = `${missing.join(", ")} was not written`;
      state.inflight = call;
      return ingest(runDir, state, meta);
    }
    state.lastWork[stage] = { call: call.id, denials: meta.denials };
    state.pending = "review";
    let rejectedTicks = [];
    if (stage === "dev") {
      const { applied, rejected } = applyTicks(runDir, state, call);
      rejectedTicks = rejected;
      if (applied.length) timeline(state, who, `ticked ${applied.map((e) => e.item).join(", ")}, each with its test run and evidence`);
      if (rejected.length) timeline(state, "ENGINE", `tick record(s) not accepted: ${rejected.map((r) => `${r.item} (${r.problem})`).join("; ")}`);
    }
    const step = logStep(state, stage, `${call.role}-round${call.round}`, renderWork(runDir, state, call, call.provider, meta.facts));
    verdict(state, `${STAGE_NAME[stage]}${stage === "dev" && state.devInput === "qa" ? " (QA fix)" : ""}, round ${call.round}`, `${who} (${call.provider})`, "READY", readRunFile(runDir, `calls/${call.id}.out.md`), { call: call.id, file: step });
    timeline(state, who, `finished ${stage} round ${call.round}${factsBrief(meta.facts)}: ${oneLine(readRunFile(runDir, `calls/${call.id}.out.md`), 160)} → ${step}`);
    // Deterministic checks run before the reviewer: TODO lists with coverage gaps go straight
    // back to METHODE, and DEV items STARK neither ticked off nor reported blocked go straight
    // back to STARK, as an engine round, without spending a review on them.
    if (stage === "plan" || stage === "dev" || stage === "wiki") {
      const gaps = stage === "plan" ? [...todoGaps(runDir), ...unitPlanGaps(runDir, state)] : stage === "dev" ? [...devGaps(runDir, state, rejectedTicks), ...unitScopeGaps(state)] : wikiGaps(state);
      if (gaps.length) {
        const gapsPath = `${base}.gaps.json`;
        const checked = { plan: "engine check of the TODO lists against request.md", dev: "engine check of the TODO items' ticks and recorded test runs", wiki: "engine check that only documentation changed" }[stage];
        writeFileSync(gapsPath, JSON.stringify({ verdict: "CHANGES_REQUESTED", findings: gaps, checked: [checked] }, null, 2));
        state.lastReview[stage] = gapsPath;
        if (stage === "dev") state.devInput = "review";
        const file = logStep(state, stage, `engine-check-round${call.round}`, renderFindings(`ENGINE · ${checked}`, { findings: gaps, checked: [checked] }));
        timeline(state, "ENGINE", `${gaps.length} problem(s) found by the engine → back to ${who} without a review: ${oneLine(gaps[0].problem, 120)} → ${file}`);
        verdict(state, `${STAGE_NAME[stage]} check, round ${call.round}`, "ENGINE", "RETURNED", gaps.map((g) => g.problem).join("; "), { call: call.id, file });
        recordReview(state, stage, call, gaps);
        return;
      }
    }
    // A recovery item STARK reports blocked needs a decision above STARK's head.
    if (stage === "dev" && state.devInput === "qa") {
      const report = readRunFile(runDir, "dev-report.md");
      const stuck = fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle && !f.done && blockedIn(report, f.key));
      if (stuck.length) {
        timeline(state, who, `reported recovery item(s) blocked: ${stuck.map((f) => f.key).join(", ")}`);
        return block(state, "ruling", { reason: "fix_blocked", stage: "dev", items: stuck.map((f) => ({ item: f.key, text: f.text, report: report.split("\n").find((l) => blockedIn(l, f.key))?.trim() ?? "" })), rule: "a recovery item reported blocked" });
      }
    }
    state.denialStreak[stage] = meta.denials.length ? (state.denialStreak[stage] ?? 0) + 1 : 0;
    if (state.denialStreak[stage] >= 2) {
      block(state, "permission", { reason: "repeated_permission_denials", resolveWith: "grant", call: call.id, callInfo: call, role: call.role, provider: call.provider, requests: [], denials: meta.denials });
    }
    return;
  }

  const outPath = `${base}.out.json`;
  const output = JSON.parse(readFileSync(outPath, "utf8"));

  if (call.mode === "qa") {
    state.lastQa = outPath;
    // Every QA item must be reported; one that is missing counts as failed.
    const qaItems = parseItems(readRunFile(runDir, TODO_QA), "QA").items;
    const refsOf = new Map(qaItems.map((q) => [q.key, q.refs]));
    const reported = new Map(output.items.map((c) => [c.id, c]));
    const items = [...output.items];
    for (const q of qaItems) {
      if (!reported.has(q.key)) items.push({ id: q.key, request_item: q.refs.find((r) => r.startsWith("REQ-")) ?? null, check: q.text, how_verified: "", result: "FAIL", evidence: "missing from the QA report", reproduce: null, evidence_files: [] });
    }
    const reqOf = (c) => (typeof c.request_item === "string" && /^REQ-\d{3,}$/.test(c.request_item) ? [c.request_item] : (refsOf.get(c.id) ?? []).filter((r) => r.startsWith("REQ-")));
    const identity = (c) => reqOf(c)[0] ?? c.id;
    const dismissed = new Set(state.dismissed.dev ?? []);
    const failing = items.filter((c) => c.result === "FAIL" && !dismissed.has(identity(c)));
    // The QA list records what was verified: each checked item is ticked with GENAU's evidence.
    for (const c of items) setTick(runDir, "QA", c.id, c.result === "PASS", c.result === "PASS" ? `${c.evidence} (verified by: ${c.how_verified ? `${c.how_verified}; ` : ""}${call.id})` : null);
    logQa(state, runDir, call, items, meta.facts);
    const summary = output.summary ?? (failing.length ? failing.map((c) => `${c.id} failed`).join(", ") : "all checks passed");
    const agreed = (output.result === "PASS") === !failing.length;
    verdict(state, `Independent QA${state.units ? " after the merge" : ""}, cycle ${call.round}`, `GENAU (${call.provider})`, failing.length ? "FAILED" : "PASSED", summary, { call: call.id, file: `${logPart(state, STAGE_LOG.qa)}/qa-${call.round}/report.md`, note: agreed ? null : `GENAU's result: ${output.result}; ${failing.length} failing item(s) after dismissals and missing items` });
    timeline(state, who, failing.length ? `FAILED QA cycle ${call.round}: ${failing.map((c) => c.id).join(", ")} → ${logPart(state, STAGE_LOG.qa)}/qa-${call.round}/` : `PASSED QA cycle ${call.round} (${items.length} checks) → ${logPart(state, STAGE_LOG.qa)}/qa-${call.round}/`);
    if (failing.length === 0) return approve(state, "qa", outPath);
    // Back to dev with a recovery TODO the engine writes from the QA evidence: STARK sees what
    // broke and how to reproduce it, not the QA TODO list. The dev stage's diff base is kept, so
    // the next review sees every change since development began.
    const cycle = state.round.qa;
    const first = (state.fixCount ?? 0) + 1;
    const keys = failing.map((_, i) => `FIX-${String(first + i).padStart(3, "0")}`);
    const lines = failing.map((c, i) => `- [ ] ${keys[i]} (${[c.id, ...reqOf(c)].join(", ")}) Fix: ${oneLine(c.check, 400)}. Observed: ${oneLine(c.evidence, 400)}.${c.reproduce ? ` Reproduce: ${oneLine(c.reproduce, 400)}.` : ""}`);
    const header = existsSync(join(runDir, TODO_FIX)) ? "" : "# Recovery TODO\n\nWritten by the engine from failed QA checks. Fix the cause of each item in general, then tick it off with the tick command and its evidence.\n";
    appendFileSync(join(runDir, TODO_FIX), `${header}\n## QA cycle ${cycle}\n\n${lines.join("\n")}\n`);
    state.fixCount = first + failing.length - 1;
    (state.fixCycles ??= {})[cycle] = { at: now(), items: keys, qa: call.id, tree: changeTree(state) };
    state.currentFixCycle = cycle;
    const recovery = logStep(state, "dev", `engine-recovery-todo-qa${cycle}`, `# Recovery TODO · QA cycle ${cycle}\n\nWritten by the engine from GENAU's failed checks; STARK fixes these, UBEL approves, then QA runs again.\n\n${lines.join("\n")}\n`);
    verdict(state, `Recovery, QA cycle ${cycle}`, "ENGINE", "RETURNED", `${keys.join(", ")} written from the failed checks, back to STARK`, { file: recovery });
    timeline(state, "ENGINE", `recovery TODO ${keys.join(", ")} written from the QA failures → back to STARK → ${recovery}`);
    // The checkboxes must stay truthful: DEV items serving a failing REQ item are unticked, and
    // need fresh evidence and a passing test run to be ticked again.
    const failingReq = new Set(failing.flatMap(reqOf));
    for (const d of parseItems(readRunFile(runDir, TODO_DEV), "DEV").items) {
      if (d.done && d.refs.some((r) => failingReq.has(r)) && setTick(runDir, "DEV", d.key, false)) {
        (state.unticked ??= {})[d.key] = { at: now(), cycle, tree: changeTree(state) };
      }
    }
    state.approved.dev = null;
    state.devInput = "qa";
    state.stage = "dev";
    state.pending = "work";
    // The engine can write a recovery TODO, but it cannot find a root cause. The same failure in
    // two QA cycles in a row goes to DENKEN instead of producing yet another FIX item.
    const repeated = failing.map(identity).filter((id) => (state.lastQaFailing ?? []).includes(id));
    state.lastQaFailing = failing.map(identity);
    for (const c of failing) {
      const id = identity(c);
      state.counts.dev[id] = (state.counts.dev[id] ?? 0) + 1;
      state.findings.dev.push({ round: state.round.dev, call: call.id, identity: id, topic: id, file: null, request_item: reqOf(c)[0] ?? null, todo: c.id, problem: `QA failed ${c.id}: ${c.check ?? ""}`, required_change: c.reproduce ?? c.evidence });
    }
    if (repeated.length) {
      return block(state, "ruling", { reason: "qa_repeated_failure", stage: "dev", identities: repeated, cycles: [call.round - 1, call.round], rule: "the same failure in two QA cycles in a row", recovery: join(runDir, TODO_FIX) });
    }
    return checkThresholds(state, "dev");
  }

  // review
  state.lastReview[stage] = outPath;
  const mergedReview = stage === "dev" && state.devInput === "merge";
  if (stage === "dev") state.devInput = "review";
  // The stage's outcome is the engine's: blocking findings still open after DENKEN's dismissals.
  // When the reviewer's own verdict says otherwise, the record says both.
  const dismissedSet = new Set(state.dismissed[stage] ?? []);
  const raised = output.findings.filter((f) => f.severity === "blocking");
  const open = raised.filter((f) => !dismissedSet.has(identityOf(f, state.findings[stage])));
  const word = open.length ? "REJECTED" : "APPROVED";
  const said = output.verdict === "APPROVED" ? "APPROVED" : "REJECTED";
  const note = said === word ? null : `reviewer's verdict: ${said}; ${open.length} open blocking finding(s)${raised.length > open.length ? `, ${raised.length - open.length} already dismissed by DENKEN` : ""}`;
  const file = logStep(state, stage, `${call.role}-${word.toLowerCase()}-round${call.round}`, renderFindings(`${who} · ${stage} review, round ${call.round} · ${call.provider}`, output, { word, note }) + renderFacts(meta.facts));
  timeline(state, who, `${open.length ? `REJECTED (${open.length} blocking): ${oneLine(open[0].problem, 120)}` : "APPROVED"}${note ? ` (${note})` : ""}${factsBrief(meta.facts)} → ${file}`);
  verdict(state, `${STAGE_NAME[stage]} review${mergedReview ? " of the merged units" : ""}, round ${call.round}`, `${who} (${call.provider})`, word, output.summary ?? (open.length ? open[0].problem : "no findings"), { call: call.id, file, note });
  if (recordReview(state, stage, call, output.findings) === 0) approve(state, stage, outPath);
}

// Records a round's findings (a reviewer's, or the engine's coverage gaps) and returns the
// number of blocking ones. With any left, the stage goes back to its worker.
function recordReview(state, stage, call, raw) {
  const dismissed = new Set(state.dismissed[stage] ?? []);
  const findings = raw.map((f) => ({ ...f, identity: identityOf(f, state.findings[stage]) })).filter((f) => !dismissed.has(f.identity));
  const blocking = findings.filter((f) => f.severity === "blocking");
  for (const f of findings.filter((f) => f.severity === "nonblocking")) state.deferred.push({ stage, round: call.round, call: call.id, ...f });
  state.history[stage].push({ round: call.round, blocking: blocking.length });
  if (blocking.length === 0) return 0;
  state.pending = "work";
  for (const f of blocking) state.findings[stage].push({ round: call.round, call: call.id, identity: f.identity, topic: f.topic, file: f.file, request_item: f.request_item ?? null, todo: f.todo ?? null, source: f.source ?? "review", problem: f.problem, required_change: f.required_change });
  for (const identity of new Set(blocking.map((f) => f.identity))) state.counts[stage][identity] = (state.counts[stage][identity] ?? 0) + 1;
  checkThresholds(state, stage);
  return blocking.length;
}

// ---------- actions shown to DENKEN

function actionFor(runDir, state) {
  if (state.stage === "done") {
    return { action: "done", run: relative(ROOT, runDir), log: state.log, verdictsSha256: state.verdictsSha, secrets: state.secretFindings ?? [], approved: state.approved, deferred: state.deferred.length, rulings: state.rulings.length, crossProvider: state.assignment.crossProvider, warnings: state.assignment.warnings, next: "Write summary.md from state.json and report to the user." };
  }
  if (state.stage === "aborted") return { action: "aborted", run: relative(ROOT, runDir), rulings: state.rulings.length, ...(state.units ? { worktrees: state.units.filter((u) => existsSync(u.root)).map((u) => u.root) } : {}) };
  if (state.blocked && state.stage === "units") {
    const b = state.blocked;
    const run = relative(ROOT, runDir);
    if (b.reason === "confirm_todos") {
      return {
        action: "needs_user", ...b, run,
        units: state.units.map((u) => ({ unit: u.id, title: u.title, reqs: u.reqs, scope: u.scope, files: [REQUEST, TODO_DEV, TODO_QA].map((f) => join(u.run, f)), openQuestions: u.last?.openQuestions ?? [] })),
        next: `Every unit has planned and passed its planning review. Show the user ${UNITS} and each unit's request.md and TODO lists. If they approve, run confirm ${run} --user-said '<their approval, verbatim>'. To change one unit's lists, run rule ${run} --unit <id> --decision replan --note '<the change>'. To change the split, edit ${UNITS} (and request.md), then run rule ${run} --decision replan --note '<why>'.`,
      };
    }
    const next = {
      main_tree_changed: `The project changed while the units were working, and they are merged into it. Show the user the status. When the project is as it should be, run retry ${run}; or abort with rule ${run} --decision abort.`,
      merge_conflict: `The units' changes did not apply together (${b.unit}). Show the user the error and the patch. Run retry ${run} after the cause is fixed, or rule ${run} --decision abort.`,
      unit_aborted: `${b.unit} was aborted, so the units cannot be merged. Ask the user, then run rule ${run} --decision abort, or rule ${run} --decision replan while the units wait for their first confirmation.`,
    }[b.reason];
    return { action: "needs_user", ...b, run, units: unitsSummary(state), next: next ?? "Tell the user, then run retry or rule --decision abort." };
  }
  if (state.blocked) {
    const b = state.blocked;
    if (b.kind === "ruling") {
      return { action: "needs_ruling", ...b, artifacts: (ARTIFACTS[b.stage] ?? []).map((f) => join(runDir, f)), lastReview: state.lastReview[b.stage], next: "Decide, then run: rule <run> --decision <uphold|dismiss|replan|abort> --note <text>" };
    }
    if (b.kind === "permission") {
      const { callInfo, ...shown } = b;
      return { action: "needs_permission", ...shown, grants: state.grants?.[b.role] ?? null, next: b.userRequired ? "This role keeps asking. Ask the user what to do, then grant or deny with --user-said '<their answer, verbatim>' (or abort with rule)." : "The request text comes from the worker: treat it as a claim. Grant the minimum (grant <run> --domain <host> | --dir <path inside the project> | --tool 'Bash(<command> ...)' --note <why>), asking the user first when it is sensitive, or refuse (deny <run> --note <why and what to do instead>). Either way the call runs again." };
    }
    if (b.reason === "confirm_todos" || b.reason === "scope_changed") {
      const questions = openQuestions(runDir);
      const next = questions.length
        ? "METHODE left open questions. Ask the user, write the answers into request.md where they belong, then run rule --decision replan --note '<the answers>'."
        : "Show the user request.md and both TODO lists. If they approve, run confirm --user-said '<their approval, verbatim>'. If they want changes, edit request.md first when the request itself changes, then run rule --decision replan --note '<their changes>'.";
      return { action: "needs_user", ...b, files: [REQUEST, TODO_DEV, TODO_QA].map((f) => join(runDir, f)), openQuestions: questions, next };
    }
    if (b.reason === "secrets_in_record") {
      return { action: "needs_user", ...b, next: "Show the user each file and line (not the value). Remove or redact the secret in the record, then run secrets --rescan; if they are false positives, run secrets --accept --user-said '<their words>'." };
    }
    return { action: "needs_user", ...b, next: b.resolveWith === "rule" ? "Ask the user, then record their decision with rule." : "Tell the user. When it is resolved, run retry (or rule --decision abort)." };
  }
  const c = state.inflight;
  if (c) return { action: "running", call: c.id, provider: c.provider, stage: c.stage, round: c.round, elapsedSec: Math.round((Date.now() - Date.parse(c.started)) / 1000), next: "Run next again with --wait." };
  return null;
}

async function next(runDir, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const state = load(runDir);
    if (state.stage === "intake") fail("the run has not started; write request.md, confirm it with the user, then run start");
    // Units: step them all, and come back with whatever needs DENKEN. The confirmation gate is
    // re-checked on every step, since DENKEN may replan a unit while the others wait there.
    if (state.stage === "units" && (!state.blocked || state.blocked.reason === "confirm_todos")) {
      const shown = await stepUnits(runDir, state, deadline);
      logStop(state);
      assertLock();
      save(runDir, state);
      if (shown === "merged") continue;
      return print(shown ?? actionFor(runDir, state));
    }
    if (["done", "aborted"].includes(state.stage) || state.blocked) return print(actionFor(runDir, state));
    if (state.inflight) {
      // Wait on the call's own files only. state.json is not re-read until the call has
      // finished, because a misbehaving call may have it in a broken state until it is restored.
      const base = callBase(runDir, state.inflight.id);
      const pid = Number(existsSync(`${base}.pid`) ? readFileSync(`${base}.pid`, "utf8") : 0);
      const alive = () => {
        if (!pid || !pidAlive(pid)) return false;
        const age = Date.now() - Date.parse(state.inflight.started);
        return existsSync(`${base}.heartbeat`) ? Date.now() - statSync(`${base}.heartbeat`).mtimeMs < 60000 : age < 30000;
      };
      // Only this attempt's result counts. A result from an earlier attempt of the same call
      // (one judged dead that finished anyway) is set aside, not ingested.
      const readMeta = () => {
        if (!existsSync(`${base}.meta.json`)) return null;
        const meta = JSON.parse(readFileSync(`${base}.meta.json`, "utf8"));
        if (!state.inflight.nonce || meta.nonce === state.inflight.nonce) return meta;
        renameSync(`${base}.meta.json`, `${base}.stale-${Date.now()}.meta.json`);
        return null;
      };
      let meta = readMeta();
      while (!meta && alive() && Date.now() < deadline) {
        // Poll quickly at first, then back off to every 3 seconds for long calls.
        const age = Date.now() - Date.parse(state.inflight.started);
        await sleep(Math.min(Math.max(200, age / 10), 3000, Math.max(0, deadline - Date.now())));
        meta = readMeta();
      }
      if (!meta) {
        if (alive()) return print(actionFor(runDir, state));
        // The call's process died. Stop whatever its agent CLI left running before moving on.
        await stopCallGroup(base, state.inflight.provider);
        meta = { status: "failed", error: "the call process exited without writing a result", finished: now() };
      }
      assertLock();
      ingest(runDir, state, meta);
      logStop(state);
      save(runDir, state);
      continue;
    }
    // The user confirmed specific content. If request.md or a TODO list changed since, stop:
    // development must not run against something the user did not approve.
    if (state.confirmed && ["dev", "qa", "wiki"].includes(state.stage)) {
      const current = confirmedHashes(runDir);
      const changed = Object.keys(current).filter((k) => current[k] !== state.confirmed.hashes[k]);
      if (changed.length) {
        block(state, "user", { reason: "scope_changed", resolveWith: "confirm", stage: "plan", changed });
        logStop(state);
        assertLock();
        save(runDir, state);
        continue;
      }
    }
    assertLock();
    launch(runDir, state);
    if (Date.now() >= deadline) return print(actionFor(runDir, load(runDir)));
  }
}

// ---------- the parent of units
// The parent steps each unit's run in the unit's worktree (next --wait 0), keeping at most
// limits.parallelUnits of them working at once, and brings DENKEN whatever a unit needs. A unit
// is queued (not started), working (a call runs), waiting (blocked on DENKEN or the user), ready
// (unblocked, waiting for a free slot), done, or aborted.
function stepUnit(u) {
  const r = spawnSync(process.execPath, [SCRIPT, "next", u.run, "--wait", "0"], { cwd: u.root, encoding: "utf8", maxBuffer: 1 << 26 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { action: "error", error: `${u.id}'s engine printed no result (exit ${r.status}): ${oneLine(r.stderr, 400)}` };
  }
}
const readUnit = (u) => {
  try {
    return JSON.parse(readFileSync(join(u.run, "state.json"), "utf8"));
  } catch {
    return null;
  }
};
// A unit's verdict lines, pulled into the parent's verdicts.md with the unit's name after the time.
function pullVerdicts(state) {
  for (const u of state.units) {
    const lines = readUnit(u)?.verdicts ?? [];
    for (const line of lines.slice(u.pulled ?? 0)) writeVerdicts(state, line.replace(/^- (\d{2}:\d{2}:\d{2}) · /, `- $1 · ${u.id} · `));
    u.pulled = Math.max(u.pulled ?? 0, lines.length);
  }
}
function unitAction(runDir, u) {
  const run = relative(ROOT, runDir);
  return { ...u.last, unit: u.id, unitTitle: u.title, run, next: `${u.last.next ?? ""} This is ${u.id}'s: run the command on this run with --unit ${u.id} (for example: rule ${run} --unit ${u.id} --decision ...). The other units keep working; run next again to move them on.`.trim() };
}
const unitsSummary = (state) => state.units.map((u) => ({ unit: u.id, status: u.status, ...(u.last?.reason ? { reason: u.last.reason } : {}), ...(u.last?.call ? { call: u.last.call } : {}) }));

async function stepUnits(runDir, state, deadline) {
  const limit = state.assignment.limits.parallelUnits ?? 3;
  for (;;) {
    let busy = state.units.filter((u) => u.status === "working").length;
    for (const u of state.units) {
      if (u.status === "done" || u.status === "aborted") continue;
      // A unit DENKEN has since unblocked is ready again, and needs a free slot like any other.
      if (u.status === "waiting" && (u.last?.action === "error" || readUnit(u)?.blocked?.since !== u.last?.since)) u.status = "ready";
      if (u.status === "waiting" || (u.status !== "working" && busy >= limit)) continue;
      const was = u.status;
      u.started = true;
      u.last = stepUnit(u);
      u.status = u.last.action === "done" ? "done" : u.last.action === "aborted" ? "aborted" : u.last.action === "running" ? "working" : "waiting";
      busy += (u.status === "working") - (was === "working");
    }
    pullVerdicts(state);
    // The units are merged into the project as it was when they started, so it must not change.
    if (projectPrint(runDir) !== state.mainPrint) {
      block(state, "user", { reason: "main_tree_changed", resolveWith: "retry", stage: "units", status: gitText("status", "--short", "--", ".", ...EXCLUDE).split("\n").filter(Boolean).slice(0, 20) });
      return null;
    }
    const aborted = state.units.find((u) => u.status === "aborted");
    if (aborted) {
      block(state, "user", { reason: "unit_aborted", resolveWith: "rule", stage: "units", unit: aborted.id });
      return null;
    }
    // Before the first confirmation, every unit's TODO lists are confirmed together.
    const gate = (u) => !state.unitsConfirmed && u.last?.reason === "confirm_todos";
    const needs = state.units.find((u) => u.status === "waiting" && !gate(u));
    if (needs) {
      if (state.blocked?.reason === "confirm_todos") state.blocked = null;
      return unitAction(runDir, needs);
    }
    if (!state.unitsConfirmed && state.units.every((u) => u.status === "waiting" && gate(u))) {
      if (state.blocked?.reason !== "confirm_todos") block(state, "user", { reason: "confirm_todos", resolveWith: "confirm", stage: "units" });
      return null;
    }
    if (state.units.every((u) => u.status === "done")) return mergeUnits(runDir, state);
    if (Date.now() >= deadline) return { action: "running", units: unitsSummary(state), next: "Run next again with --wait." };
    assertLock();
    save(runDir, state);
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
}

// Every unit is done: merge them all, or none. The units' patches (each against the common base,
// so commits an agent made are included) are applied together in an integration worktree first;
// only the combined patch that results is applied to the project.
function mergeUnits(runDir, state) {
  const integration = join(state.unitHome, "INTEGRATION");
  removeWorktree(integration);
  addWorktree(integration, state.unitBase);
  const dir = join(runDir, "units");
  mkdirSync(dir, { recursive: true });
  const conflict = (unit, patch, error) => {
    block(state, "user", { reason: "merge_conflict", resolveWith: "retry", stage: "units", unit, patch, error: oneLine(error, 800) });
    return null;
  };
  const merged = [];
  for (const u of state.units) {
    gitAt(u.root, ["add", "-A", "--", ".", ...EXCLUDE]);
    const patch = gitAt(u.root, ["diff", "--cached", "--binary", state.unitBase, "--", ".", ...EXCLUDE]).out;
    const files = gitAt(u.root, ["diff", "--cached", "--name-only", state.unitBase, "--", ".", ...EXCLUDE]).out.toString("utf8").split("\n").filter(Boolean);
    const committed = gitAt(u.root, ["rev-parse", "HEAD"]).out.toString("utf8").trim() !== state.unitBase;
    const path = join(dir, `${u.id}.patch`);
    writeFileSync(path, patch);
    merged.push({ unit: u.id, files, committed });
    if (!patch.length) continue;
    const check = gitAt(integration, ["apply", "--check", "--binary", path]);
    if (!check.ok) return conflict(u.id, path, check.err);
    gitAt(integration, ["apply", "--binary", path]);
  }
  gitAt(integration, ["add", "-A", "--", "."]);
  const combined = gitAt(integration, ["diff", "--cached", "--binary", state.unitBase, "--", "."]).out;
  const all = join(dir, "merged.patch");
  writeFileSync(all, combined);
  if (projectPrint(runDir) !== state.mainPrint) {
    block(state, "user", { reason: "main_tree_changed", resolveWith: "retry", stage: "units", status: gitText("status", "--short", "--", ".", ...EXCLUDE).split("\n").filter(Boolean).slice(0, 20) });
    return null;
  }
  // The project before the merge is where the merged change is measured from.
  const base = gitText("stash", "create") || gitText("rev-parse", "-q", "--verify", "HEAD") || EMPTY_TREE;
  const untracked = gitText("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE).split("\n").filter(Boolean);
  if (combined.length) {
    const check = gitAt(ROOT, ["apply", "--check", "--binary", all]);
    if (!check.ok) return conflict("all", all, check.err);
    const applied = gitAt(ROOT, ["apply", "--binary", all]);
    if (!applied.ok) return conflict("all", all, applied.err);
  }
  state.stageBase.dev = base;
  (state.stageEnteredAt ??= {}).dev = now();
  (state.untrackedAtStage ??= {}).dev = untracked;
  composeMerged(runDir, state);
  state.confirmed = { at: now(), userSaid: state.unitsConfirmed?.userSaid ?? null, hashes: confirmedHashes(runDir), units: true };
  // The units' own records are already in the ai-log; keep each unit's final state beside them.
  const log = logDir(state);
  for (const u of state.units) {
    mkdirSync(join(log, "raw", u.id), { recursive: true });
    if (existsSync(join(u.run, "state.json"))) copyFileSync(join(u.run, "state.json"), join(log, "raw", u.id, "state.json"));
    copyFileSync(join(dir, `${u.id}.patch`), join(log, "raw", u.id, "merge.patch"));
  }
  const step = logStep(state, "dev", "engine-merge", `# Merge of the units\n\nEvery unit was planned, built, reviewed and verified in its own worktree. Their changes were applied together in an integration worktree, then to the project as one patch.\n\n${merged.map((m) => `## ${m.unit}${m.committed ? " (its agent committed; the commits are included)" : ""}\n\n${m.files.map((f) => `- ${f}`).join("\n") || "No changes."}`).join("\n\n")}\n`);
  verdict(state, "Merge", "ENGINE", "MERGED", `${merged.map((m) => `${m.unit} (${m.files.length} file(s))`).join(", ")} merged into the project; UBEL now reviews the merged change, then GENAU verifies it again`, { file: step });
  timeline(state, "ENGINE", `merged ${merged.map((m) => `${m.unit} (${m.files.length} file(s))`).join(", ")} → ${step}`);
  tearDownUnits(state);
  rmSync(state.unitHome, { recursive: true, force: true });
  try {
    if (!readdirSync(dirname(state.unitHome)).length) rmSync(dirname(state.unitHome), { recursive: true });
  } catch {}
  state.unitsMerged = now();
  state.stage = "dev";
  state.pending = "review";
  state.round.dev = 1;
  state.devInput = "merge";
  state.approved.plan = "units";
  return "merged";
}

// The merged TODO lists and report, from the units': every DEV item as ticked, with its
// evidence; every QA item unticked, to be verified again; and QA-001, the whole test suite.
function composeMerged(runDir, state) {
  const r = parseRequest(readRunFile(runDir, REQUEST));
  const copies = (prefixes) => prefixes.flatMap((p) => r[p].items.map((i) => i.text)).join("\n") || "- None";
  const part = (u, file, heading) => (section(readRunFile(u.run, file), heading) ?? "").trim();
  const byUnit = (file, heading, shape = (x) => x) => state.units.map((u) => `### ${u.id}: ${u.title}\n\n${shape(part(u, file, heading)) || "- None"}`).join("\n\n");
  writeFileSync(join(runDir, TODO_DEV), `# Development TODO (merged)\n\nThe units' development TODO lists, merged. Each unit was built, reviewed and verified in its own worktree.\n\n## Acceptance\n${copies(["REQ"])}\n\n## Do not build\n${copies(["OUT", "LATER"])}\n\n## Cautions\n${copies(["CAUTION"])}\n\n## Approach\n${byUnit(TODO_DEV, "Approach")}\n\n## TODO\n${byUnit(TODO_DEV, "TODO")}\n\n## Open questions\n- None\n`);
  writeFileSync(join(runDir, TODO_QA), `# QA TODO (merged)\n\n## Checks\n- [ ] QA-001 (${r.REQ.items.map((i) => i.key).join(", ")}) The project's whole test suite passes on the merged result. How: run the project's full test command. Expected: every test passes.\n\n${byUnit(TODO_QA, "Checks", planText)}\n`);
  writeFileSync(join(runDir, "dev-report.md"), `# Development report (merged)\n\n${state.units.map((u) => `## ${u.id}: ${u.title}\n\n${readRunFile(u.run, "dev-report.md").replace(/^#[^\n]*\n/, "").trim() || "(none)"}`).join("\n\n")}\n`);
}

function confirmUnits(runDir, state, userSaid) {
  if (state.blocked?.reason !== "confirm_todos") fail("nothing to confirm: the units are not all waiting for confirmation; run next");
  const questions = state.units.flatMap((u) => (u.last?.openQuestions ?? []).map((q) => `${u.id}: ${q}`));
  if (questions.length) fail(`cannot confirm while units have open questions: ${questions.join("; ")}. Ask the user, then replan those units with rule --unit <id> --decision replan.`);
  const failed = [];
  for (const u of state.units) {
    const r = spawnSync(process.execPath, [SCRIPT, "confirm", u.run, "--user-said", userSaid], { cwd: u.root, encoding: "utf8" });
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {}
    if (out?.action !== "confirmed") failed.push(`${u.id}: ${out?.error ?? oneLine(r.stderr, 300)}`);
  }
  // Units that were confirmed go ahead; any that were not are then confirmed one by one.
  if (failed.length < state.units.length) {
    state.unitsConfirmed = { at: now(), userSaid };
    state.blocked = null;
    timeline(state, "USER via DENKEN", `confirmed the units' TODO lists: "${oneLine(userSaid, 140)}"`);
    timeline(state, "RESUME", "the units start development");
  }
  assertLock();
  save(runDir, state);
  if (failed.length) fail(`not confirmed: ${failed.join("; ")}`);
  print({ action: "confirmed", units: state.units.map((u) => u.id), next: "Development starts in every unit. Run next with --wait." });
}

// A unit's run is stopped when the run it belongs to is aborted or split again.
function abortUnits(state) {
  for (const u of state.units ?? []) {
    if (u.status !== "done" && existsSync(u.run)) spawnSync(process.execPath, [SCRIPT, "_abort", u.run], { cwd: u.root, encoding: "utf8" });
    u.status = u.status === "done" ? "done" : "aborted";
  }
}

function ruleUnits(runDir, state, decision, note) {
  const id = `R${state.rulings.length + 1}`;
  const reason = state.blocked?.reason ?? "units";
  if (decision === "replan") {
    if (state.blocked?.reason !== "confirm_todos" || state.unitsConfirmed) fail("the split can change only while every unit waits for the first confirmation; to replan one unit, use --unit <id>");
    const problems = [...requestProblems(readRunFile(runDir, REQUEST)), ...unitsProblems(runDir).problems];
    if (problems.length) fail(`fix request.md and ${UNITS} before splitting again: ${problems.join("; ")}`);
    abortUnits(state);
    createUnits(runDir, state, unitsProblems(runDir).units);
    logRequest(state, runDir);
    state.blocked = null;
  } else if (decision === "abort") {
    abortUnits(state);
    state.stage = "aborted";
    state.blocked = null;
  } else fail("for the whole split, the decisions are replan (a new split) or abort; to rule on one unit, add --unit <id>");
  state.rulings.push({ id, stage: "units", subject: "the split", reason, decision, at: now() });
  const ruling = logStep(state, "plan", `denken-ruling-${id}-${decision}`, `# DENKEN · ruling ${id} · ${decision}\n\nOn: the split into units\n\n${note.trim()}\n`);
  timeline(state, "DENKEN", `ruling ${id} (${decision}) on the split: ${oneLine(note, 140)} → ${ruling}`);
  verdict(state, `Ruling ${id} on the split`, "DENKEN", decision.toUpperCase(), note, { file: ruling });
  appendFileSync(join(runDir, "rulings.md"), `${state.rulings.length === 1 ? "# Rulings\n\n" : ""}## ${id} · units · the split · ${decision}\n\n${note.trim()}\n\n`);
  assertLock();
  save(runDir, state);
  print({ action: "ruled", id, decision, stage: state.stage, ...(decision === "abort" ? { worktrees: state.units.map((u) => u.root) } : { units: state.units.map((u) => u.id) }), next: decision === "abort" ? "Tell the user the run was aborted. The units' worktrees are kept for inspection." : "Run next with --wait." });
}

// ---------- commands

function cmdNew(name) {
  if (!name) fail("usage: new <slug>");
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = join(DENKEN_DIR, "runs", `${stamp}-${slug(name)}`);
  if (existsSync(dir)) fail(`run already exists: ${relative(ROOT, dir)}`);
  mkdirSync(join(dir, "calls"), { recursive: true });
  const ignore = join(DENKEN_DIR, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "runs/\nlocks/\nconfig.local.json\n");
  const state = { version: 1, task: name, created: now(), stage: "intake", log: createLog(name), verdicts: [] };
  state.verdictsSha = hashFile(join(ROOT, state.log, "verdicts.md"));
  timeline(state, "DENKEN", `run created: ${name}`);
  save(dir, state);
  print({ action: "created", run: relative(ROOT, dir), log: state.log, next: `Record your conversation with the user in ${relative(ROOT, join(dir, "conversation.md"))}, write ${relative(ROOT, join(dir, REQUEST))}, confirm it with the user, then run start.` });
}

function cmdStart(runDir) {
  const state = load(runDir);
  if (state.stage !== "intake") fail(`run already started (stage: ${state.stage})`);
  const problems = requestProblems(readRunFile(runDir, REQUEST));
  if (problems.length) fail(problems.join("; "));
  if (gitText("rev-parse", "--is-inside-work-tree") !== "true") fail("DENKEN needs a git work tree to detect file changes; run git init first");
  const config = resolveConfig(ROOT);
  if (config.errors.length) {
    print({ action: "needs_user", reason: "config", errors: config.errors, warnings: config.warnings, next: "Fix the configuration with config.mjs, then run start again." });
    process.exit(1);
  }
  if (config.sameReviewer.length && !config.allowSameReviewer) {
    print({ action: "needs_user", reason: "same_reviewer", stages: config.sameReviewer, next: "The same model would check its own work. Ask the user: set a different reviewer (richter, ubel, frieren) or genau model or effort with config.mjs, or set allowSameReviewer true. Then run start again." });
    process.exit(1);
  }
  const split = existsSync(join(runDir, UNITS)) ? unitsProblems(runDir) : null;
  if (split?.problems.length) fail(`${UNITS}: ${split.problems.join("; ")}`);
  Object.assign(state, runFields({ crossProvider: config.crossProvider, sameReviewer: config.sameReviewer, stages: config.stages, limits: config.limits, warnings: config.warnings }, gitText("rev-parse", "-q", "--verify", "HEAD") || null));
  logRequest(state, runDir);
  const roles = Object.entries(config.stages).map(([stage, s]) => Object.entries(s).map(([k, a]) => `${stage}.${k}=${a.provider}`).join(" ")).join(" · ");
  timeline(state, "DENKEN", `the user agreed the request; run started (${roles}) → 00-request/request.md`);
  if (split) {
    timeline(state, "DENKEN", `the request is split into ${split.units.length} units, built in parallel: ${split.units.map((u) => `${u.id} (${u.reqs.join(", ")}) in ${u.scope.join(", ")}`).join("; ")} → 00-request/${UNITS}`);
    createUnits(runDir, state, split.units);
    state.stage = "units";
  } else enterStage(state, "plan");
  assertLock();
  save(runDir, state);
  print({ action: "started", log: state.log, run: relative(ROOT, runDir), units: state.units?.map((u) => ({ unit: u.id, reqs: u.reqs, scope: u.scope, worktree: u.root })) ?? null, crossProvider: config.crossProvider, stages: config.stages, limits: config.limits, warnings: config.warnings, next: "Run next with --wait." });
}

function cmdRule(runDir, args) {
  const state = load(runDir);
  if (!state.blocked && state.stage !== "units") fail("nothing to rule on: the run is not blocked");
  const decision = args[args.indexOf("--decision") + 1];
  if (!["uphold", "dismiss", "replan", "abort"].includes(decision)) fail("--decision must be uphold, dismiss, replan or abort");
  const noteIndex = args.indexOf("--note");
  const fileIndex = args.indexOf("--note-file");
  const note = noteIndex >= 0 ? args[noteIndex + 1] : fileIndex >= 0 ? readFileSync(args[fileIndex + 1], "utf8") : null;
  if (!note?.trim()) fail("a ruling needs --note <text> or --note-file <path> explaining the decision and the direction");

  if (state.stage === "units") return ruleUnits(runDir, state, decision, note);
  const b = state.blocked;
  const stage = b.stage ?? state.stage;
  if (["confirm_todos", "scope_changed"].includes(b.reason) && !["replan", "abort"].includes(decision)) {
    fail("at the TODO confirmation, use confirm when the user approves, or rule --decision replan|abort");
  }
  if (decision === "replan") {
    const problems = [...requestProblems(readRunFile(runDir, REQUEST)), ...reusedIds(runDir, state)];
    if (problems.length) fail(`fix request.md before replanning: ${problems.join("; ")}`);
  }
  // Dismissals are per finding: a stage-wide ruling must name each identity it dismisses.
  const open = new Set(state.findings[stage]?.filter((f) => f.round === state.round[stage]).map((f) => f.identity));
  const listIndex = args.indexOf("--identities");
  const listed = listIndex >= 0 ? String(args[listIndex + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const targets = [...new Set([...(b.identity ? [b.identity] : []), ...listed])];
  if (decision === "dismiss") {
    if (targets.length === 0) fail(`name the findings to dismiss with --identities <a,b>. Open: ${[...open].join(", ") || "none"}`);
    const unknown = targets.filter((t) => t !== b.identity && !open.has(t));
    if (unknown.length) fail(`not open in this stage: ${unknown.join(", ")}. Open: ${[...open].join(", ")}`);
  }
  const id = `R${state.rulings.length + 1}`;
  const subject = decision === "dismiss" ? targets.join(", ") : b.identity ?? b.reason;
  assertLock();
  state.rulings.push({ id, stage, subject, reason: b.reason, decision, at: now() });
  const ruling = logStep(state, STAGE_LOG[stage] ? stage : "plan", `denken-ruling-${id}-${decision}`, `# DENKEN · ruling ${id} · ${decision}\n\nOn: ${subject} (${b.reason})\n\n${note.trim()}\n`);
  timeline(state, "DENKEN", `ruling ${id} (${decision}) on ${subject}: ${oneLine(note, 140)} → ${ruling}`);
  verdict(state, `Ruling ${id} on ${subject}`, "DENKEN", decision.toUpperCase(), note, { file: ruling });
  appendFileSync(join(runDir, "rulings.md"), `${state.rulings.length === 1 ? "# Rulings\n\n" : ""}## ${id} · ${stage} · ${subject} · ${decision}\n\n${note.trim()}\n\n`);
  state.blocked = null;
  state.capBase[stage] = state.round[stage];
  state.historyBase[stage] = state.history[stage]?.length ?? 0;
  if (b.identity) {
    state.counts[stage][b.identity] = 0;
    (state.ruled[stage] ??= []).push(b.identity);
  }

  if (decision === "abort") state.stage = "aborted";
  else if (decision === "replan") {
    for (const s of ["plan", "dev", "qa", "wiki"]) state.approved[s] = null;
    state.devInput = null;
    state.confirmed = null;
    enterStage(state, "plan");
  } else if (decision === "dismiss") {
    (state.dismissed[stage] ??= []).push(...targets);
    for (const t of targets) state.counts[stage][t] = 0;
    // Approve only when nothing blocking remains open after the dismissal. The dismissed
    // findings are kept, marked as such, for the summary.
    const dismissed = new Set(state.dismissed[stage]);
    const lastRound = state.findings[stage].filter((f) => f.round === state.round[stage]);
    if (lastRound.every((f) => dismissed.has(f.identity)) && state.lastReview[stage]) {
      for (const f of lastRound) state.deferred.push({ stage, round: f.round, call: f.call, ...f, severity: "dismissed" });
      verdict(state, `${STAGE_NAME[stage] ?? stage} review`, "DENKEN", "APPROVED", `no blocking finding is left open: ${targets.join(", ")} dismissed`, { file: ruling, note: `by ruling ${id}` });
      approve(state, stage, `${state.lastReview[stage]} + ruling ${id}`);
    }
  }
  assertLock();
  save(runDir, state);
  timeline(state, "RESUME", state.stage === "aborted" ? "the run was aborted" : `the run continues in ${state.stage}`);
  print({ action: "ruled", id, decision, stage: state.stage, next: state.stage === "aborted" ? "Tell the user the run was aborted." : "Run next with --wait." });
}

function cmdRetry(runDir) {
  const state = load(runDir);
  const b = state.blocked;
  if (!b || b.kind !== "user") fail("nothing to retry: the run is not waiting on the user");
  if (b.resolveWith !== "retry") fail(`this block is resolved with ${b.resolveWith}, not retry`);
  // Units: the project as it is now becomes what they are merged into, and the merge is tried again.
  if (state.stage === "units") {
    state.blocked = null;
    state.mainPrint = projectPrint(runDir);
    timeline(state, "DENKEN", `retry after ${b.reason}`);
    assertLock();
    save(runDir, state);
    return print({ action: "resumed", next: "Run next with --wait." });
  }
  state.blocked = null;
  const last = state.calls.findLast((c) => c.id === b.call);
  const [stage, role, round] = b.call.split("-");
  state.retryCall = { stage, role, mode: last.mode, round: Number(round), attempt: 1 };
  if (last.mode === "work") state.pending = "work";
  timeline(state, "DENKEN", `retry ${b.call} after ${b.reason}`);
  assertLock();
  save(runDir, state);
  print({ action: "resumed", next: "Run next with --wait." });
}

// The last thing a running call did, read from the tail of its streamed log.
function lastActivity(logPath) {
  if (!existsSync(logPath)) return null;
  const { size, mtime } = statSync(logPath);
  const length = Math.min(size, 65536);
  const buffer = Buffer.alloc(length);
  const fd = openSync(logPath, "r");
  readSync(fd, buffer, 0, length, size - length);
  closeSync(fd);
  const describe = (e) => {
    const part = e.type === "assistant" ? e.message?.content?.findLast?.((c) => c.type === "tool_use" || c.type === "text") : null;
    if (part?.type === "tool_use") return `${part.name} ${JSON.stringify(part.input)}`;
    if (part?.type === "text") return part.text;
    if (e.item?.type === "command_execution") return `command: ${e.item.command}`;
    if (e.item?.type === "agent_message") return e.item.text;
    return e.item?.type ?? null;
  };
  for (const line of buffer.toString("utf8").split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const text = describe(JSON.parse(line));
      if (text) return { updated: mtime.toISOString(), last: String(text).replace(/\s+/g, " ").slice(0, 160) };
    } catch {}
  }
  return { updated: mtime.toISOString(), last: null };
}

// One engine process per run. Claude Code moves a slow command to the background instead of
// killing it, so without a lock two `next` processes could ingest or launch the same call.
// The lock is a directory (mkdir is atomic), refreshed by a heartbeat. A lock whose heartbeat
// is older than LOCK_STALE_MS is stale no matter what its pid is, so a reused pid cannot keep
// a dead run busy. A stale lock is taken over by renaming it away, which only one process can do.
const LOCK_STALE_MS = 30000;
const lock = { dir: null, nonce: null };

function holdsLock() {
  try {
    return JSON.parse(readFileSync(join(lock.dir, "owner"), "utf8")).nonce === lock.nonce;
  } catch {
    return false;
  }
}

function assertLock() {
  if (!holdsLock()) fail("this engine process lost the run lock (another process took the run over); stopping without changing anything");
}

async function acquireLock(runDir, waitMs) {
  mkdirSync(join(DENKEN_DIR, "locks"), { recursive: true });
  const dir = join(DENKEN_DIR, "locks", `${basename(runDir)}.lock`);
  const deadline = Date.now() + waitMs;
  const nonce = randomUUID();
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid, nonce, since: now() }));
      Object.assign(lock, { dir, nonce });
      setInterval(() => {
        try {
          const t = new Date();
          utimesSync(dir, t, t);
        } catch {}
      }, 5000).unref();
      const release = () => holdsLock() && rmSync(dir, { recursive: true, force: true });
      process.on("exit", release);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => {
          release();
          process.exit(128);
        });
      }
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let stale;
    try {
      const age = Date.now() - statSync(dir).mtimeMs;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(join(dir, "owner"), "utf8"));
      } catch {}
      // No owner file yet means another process is between mkdir and writing it.
      stale = age > LOCK_STALE_MS || (owner ? !pidAlive(owner.pid) : age > 2000);
    } catch {
      continue;
    }
    if (stale) {
      const grave = `${dir}.stale-${randomUUID()}`;
      try {
        renameSync(dir, grave);
        rmSync(grave, { recursive: true, force: true });
      } catch {}
      continue;
    }
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

function cmdConfirm(runDir, args) {
  const state = load(runDir);
  const i = args.indexOf("--user-said");
  const userSaid = i >= 0 ? String(args[i + 1] ?? "").trim() : "";
  if (!userSaid) fail("record the user's approval: confirm <run> --user-said '<what they said, verbatim>'");
  if (state.stage === "units") return confirmUnits(runDir, state, userSaid);
  if (!["confirm_todos", "scope_changed"].includes(state.blocked?.reason)) fail("nothing to confirm: the run is not waiting for TODO confirmation");
  if (state.blocked.reason === "scope_changed") {
    const current = confirmedHashes(runDir);
    const reviewed = ["request", "todoDev"].filter((k) => current[k] !== state.confirmed.hashes[k]);
    if (reviewed.length) fail(`${reviewed.join(" and ")} changed since the user confirmed; no reviewer has checked the new content. Restore it, or run rule --decision replan.`);
  }
  const problems = [...requestProblems(readRunFile(runDir, REQUEST)), ...reusedIds(runDir, state), ...[...todoGaps(runDir), ...unitPlanGaps(runDir, state)].map((g) => g.problem)];
  if (problems.length) fail(`cannot confirm: ${problems.join("; ")}. Fix request.md and replan.`);
  const questions = openQuestions(runDir);
  if (questions.length) fail(`cannot confirm while todo-dev.md has open questions: ${questions.join("; ")}. Ask the user, write the answers into request.md, then replan.`);
  state.blocked = null;
  state.confirmed = { at: now(), userSaid, hashes: confirmedHashes(runDir) };
  for (const i of requestItems(runDir)) (state.requestIds ??= {})[i.key] = contract(i.text);
  (state.confirmations ??= []).push(state.confirmed);
  logRequest(state, runDir);
  const file = logStep(state, "plan", "user-confirmed", `# The user confirmed the scope and TODO lists\n\n> ${userSaid}\n\nConfirmed content (hashes, with checkbox state ignored):\n\n${Object.entries(state.confirmed.hashes).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\n## todo-dev.md\n\n${readRunFile(runDir, TODO_DEV).trim()}\n\n## todo-qa.md\n\n${readRunFile(runDir, TODO_QA).trim()}\n`);
  timeline(state, "USER via DENKEN", `confirmed the scope and TODO lists: "${oneLine(userSaid, 140)}" → ${file}`);
  verdict(state, "Confirmation", "USER", "CONFIRMED", userSaid, { file });
  timeline(state, "RESUME", "development starts");
  assertLock();
  save(runDir, state);
  print({ action: "confirmed", next: "Development starts. Run next with --wait." });
}

// `request-permission <run> --need <what> --why <why>`: a worker or GENAU, during its call.
function cmdRequestPermission(runDir, args) {
  const state = load(runDir);
  const call = state.inflight;
  if (!call || call.mode === "review") fail("request-permission is for a worker or GENAU, during its call");
  const value = (flag) => (args.indexOf(flag) >= 0 ? String(args[args.indexOf(flag) + 1] ?? "").trim() : "");
  const need = value("--need");
  const why = value("--why");
  if (!need || !why) fail('usage: request-permission <run> --need "<network | dir:<path> | tool:<pattern> | ...>" --why "<what it is for>"');
  appendFileSync(`${callBase(runDir, call.id)}.permission.jsonl`, `${JSON.stringify({ need, why, attempt: call.attempt, at: now() })}\n`);
  print({ action: "requested", need, next: "Stop now and end your turn with a one-line summary. DENKEN decides, then runs you again." });
}

// DENKEN's answer to a permission request. A grant widens what the role may do for the rest of
// the run; either way the same call runs again, and the decision is written to rulings.md.
// Grants are kept narrow on purpose, because the request text comes from the worker:
//   --dir     inside the project; outside it only with the user's words, and never / or a home
//   --domain  network access to named hosts (Claude); --network for all hosts needs the user's words
//   --tool    Bash(<command> ...) patterns that start with a literal command (Claude only)
function cmdPermissionDecision(runDir, args, decision) {
  const state = load(runDir);
  const b = state.blocked;
  if (b?.kind !== "permission") fail("nothing to decide: the run is not waiting on a permission request");
  const value = (flag) => (args.indexOf(flag) >= 0 ? String(args[args.indexOf(flag) + 1] ?? "").trim() : "");
  const all = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
  const note = value("--note");
  const userSaid = value("--user-said");
  if (!note) fail(`${decision} needs --note <why>, so the worker and the record know the reason`);
  if (b.userRequired && !userSaid) fail(`this role has asked too often (${b.reason}); ask the user and pass their answer with --user-said '<verbatim>'`);
  const grant = { network: args.includes("--network"), domains: all("--domain"), dirs: all("--dir").map((d) => resolve(ROOT, d)), tools: all("--tool") };
  if (decision === "grant") {
    if (!grant.network && !grant.domains.length && !grant.dirs.length && !grant.tools.length) fail("name what to grant: --domain <host>, --dir <path>, --tool <pattern>, or --network");
    // Real paths, so a symlink inside the project cannot point a grant at the home directory.
    const home = process.env.HOME ? realpathSync(process.env.HOME) : "";
    const root = realpathSync(ROOT);
    const sensitive = [".ssh", ".aws", ".gnupg", ".config", ".claude", ".codex", ".kube", ".docker", ".netrc"].map((d) => join(home, d));
    grant.dirs = grant.dirs.map((d) => {
      if (!existsSync(d)) fail(`${d} does not exist`);
      return realpathSync(d);
    });
    for (const d of grant.dirs) {
      if (d === "/" || d === home || home.startsWith(`${d}/`)) fail(`refusing to grant ${d}: it is a root or home directory`);
      if (sensitive.some((x) => d === x || d.startsWith(`${x}/`))) fail(`refusing to grant ${d}: it holds credentials or agent configuration`);
      if (d !== root && !d.startsWith(`${root}/`) && !userSaid) fail(`${d} is outside the project; ask the user and pass their answer with --user-said '<verbatim>'`);
    }
    if (grant.network && !userSaid) fail("--network opens every host; prefer --domain <host>, or ask the user and pass their answer with --user-said");
    if (grant.domains.length && b.provider !== "claude") fail("--domain grants apply to Claude only; Codex network access is all or nothing (--network, with --user-said)");
    if (grant.tools.length && b.provider !== "claude") fail("--tool grants apply to Claude only; Codex has no per-command allowlist");
    // An allow rule approves before auto mode's classifier looks, so a pattern for a shell, an
    // interpreter or a network tool would be arbitrary execution.
    const RUNS_ANYTHING = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "env", "exec", "eval", "xargs", "sudo", "su", "node", "deno", "bun", "npx", "bunx", "python", "python3", "ruby", "perl", "php", "lua", "osascript", "pwsh", "powershell", "curl", "wget", "nc", "ncat", "ssh", "scp", "rsync", "ftp", "telnet"]);
    for (const t of grant.tools) {
      const m = t.match(/^Bash\(([A-Za-z0-9_.\/-]+)(?: [^)]*)?\)$/);
      if (!m) fail(`refusing tool pattern ${t}: use Bash(<command> ...) starting with a literal command, never a bare wildcard`);
      if (RUNS_ANYTHING.has(basename(m[1]))) fail(`refusing tool pattern ${t}: ${m[1]} can run anything`);
      if (/\*\)$/.test(t) && !userSaid) fail(`${t} ends in a wildcard; ask the user and pass their answer with --user-said '<verbatim>'`);
    }
  }
  const current = ((state.grants ??= {})[b.role] ??= { network: false, domains: [], dirs: [], tools: [] });
  current.domains ??= [];
  if (decision === "grant") {
    current.network ||= grant.network;
    current.domains = [...new Set([...current.domains, ...grant.domains])];
    current.dirs = [...new Set([...current.dirs, ...grant.dirs])];
    current.tools = [...new Set([...current.tools, ...grant.tools])];
  }
  const what = decision === "grant" ? [grant.network && "network (all hosts)", ...grant.domains.map((d) => `domain ${d}`), ...grant.dirs.map((d) => `dir ${d}`), ...grant.tools.map((t) => `tool ${t}`)].filter(Boolean).join(", ") : b.requests.map((r) => r.need).join(", ") || "the blocked actions";
  const id = `P${(state.permissionDecisions ?? []).length + 1}`;
  (state.permissionDecisions ??= []).push({ id, call: b.call, role: b.role, decision, by: "denken", what, note, userSaid: userSaid || null, requests: b.requests, at: now() });
  const file = logStep(state, b.callInfo.stage, `denken-permission-${id}-${decision}`, `# DENKEN · permission ${id} · ${decision} · ${b.role.toUpperCase()}\n\nAsked for: ${b.requests.map((r) => `${r.need} (${r.why})`).join("; ") || "permission denials"}\n\n${decision === "grant" ? `Granted: ${what}` : "Denied"}\n\n${note}\n${userSaid ? `\nThe user said: "${userSaid}"\n` : ""}`);
  timeline(state, "DENKEN", `${decision === "grant" ? `granted ${what} to` : `denied ${what} for`} ${b.role.toUpperCase()}: ${oneLine(note, 140)}${userSaid ? ` (the user: "${oneLine(userSaid, 80)}")` : ""} → ${file}`);
  timeline(state, "RESUME", `${b.call} runs again`);
  verdict(state, `Permission ${id} for ${b.role.toUpperCase()}`, "DENKEN", decision === "grant" ? "GRANTED" : "DENIED", `${what}: ${note}`, { call: b.call, file });
  assertLock();
  appendFileSync(join(runDir, "rulings.md"), `${existsSync(join(runDir, "rulings.md")) ? "" : "# Rulings\n\n"}## ${id} · permission · ${b.role.toUpperCase()} · ${decision === "grant" ? `granted ${what}` : `denied ${what}`}\n\n${note}\n\n`);
  const { stage, role, mode, round, attempt } = b.callInfo;
  state.retryCall = { stage, role, mode, round, attempt: attempt + 1 };
  if (mode === "work") state.pending = "work";
  state.denialStreak[stage] = 0;
  state.blocked = null;
  save(runDir, state);
  print({ action: decision === "grant" ? "granted" : "denied", id, role, what, next: `${b.call} runs again. Run next with --wait.` });
}

// After a secrets stop: rescan once the files are cleaned up, or accept the findings on the
// user's word (false positives). Either way the run then finishes.
function cmdSecrets(runDir, args) {
  const state = load(runDir);
  if (state.blocked?.reason !== "secrets_in_record") fail("nothing to do: the run is not stopped on secrets in the record");
  const i = args.indexOf("--user-said");
  const userSaid = i >= 0 ? String(args[i + 1] ?? "").trim() : "";
  if (args.includes("--accept")) {
    if (!userSaid) fail("accepting the findings needs the user's words: --accept --user-said '<verbatim>'");
    state.secretsAccepted = { at: now(), userSaid, findings: state.secretFindings };
    timeline(state, "USER via DENKEN", `accepted ${state.secretFindings.length} secret-scan finding(s) as safe: "${oneLine(userSaid, 120)}"`);
  } else if (args.includes("--rescan")) {
    state.secretFindings = scanSecrets(state);
    if (state.secretFindings.length) {
      assertLock();
      save(runDir, state);
      print({ action: "needs_user", reason: "secrets_in_record", findings: state.secretFindings, next: "Still found. Clean the files, then rescan, or accept with the user's words." });
      process.exit(1);
    }
    timeline(state, "ENGINE", "secret scan: clean after the files were cleaned up");
  } else fail("usage: secrets <run> --rescan | --accept --user-said '<verbatim>'");
  state.blocked = null;
  timeline(state, "ENGINE", "DONE: every stage approved");
  finish(state);
  enterStage(state, "done");
  assertLock();
  save(runDir, state);
  print(actionFor(runDir, state));
}

function cmdStatus(runDir) {
  const s = load(runDir);
  print({
    run: relative(ROOT, runDir),
    task: s.task,
    stage: s.stage,
    pending: s.pending,
    rounds: s.round,
    inflight: s.inflight && { call: s.inflight.id, provider: s.inflight.provider, started: s.inflight.started, activity: lastActivity(`${callBase(runDir, s.inflight.id)}.log`) },
    blocked: s.blocked && { kind: s.blocked.kind, reason: s.blocked.reason },
    approved: s.approved,
    topics: s.counts,
    deferred: s.deferred?.length ?? 0,
    rulings: s.rulings?.map((r) => `${r.id} ${r.stage} ${r.subject} ${r.decision}`),
    calls: s.calls?.slice(-6).map((c) => `${c.id} ${c.provider} ${c.status ?? "running"}`),
    ...(s.units ? { units: s.units.map((u) => ({ unit: u.id, status: u.status, stage: readUnit(u)?.stage ?? null, reason: u.last?.reason ?? null, worktree: existsSync(u.root) ? u.root : null })) } : {}),
  });
}

const [command, runArg, ...rest] = process.argv.slice(2);
const locked = async (fn) => {
  const runDir = runDirOf(runArg);
  if (!(await acquireLock(runDir, 0))) fail("another DENKEN engine process is working on this run; wait for it, then try again");
  fn(runDir);
};
// A command for one unit goes through the parent run, which alone says where the unit lives.
const unitAt = rest.indexOf("--unit");
if (unitAt >= 0 && ["rule", "retry", "confirm", "grant", "deny", "status", "secrets"].includes(command)) {
  const parent = load(runDirOf(runArg));
  const u = (parent.units ?? []).find((x) => x.id === rest[unitAt + 1]);
  if (!u) fail(`${rest[unitAt + 1] ?? "(none)"} is not a unit of this run${parent.units ? `; its units are ${parent.units.map((x) => x.id).join(", ")}` : ""}`);
  if (!existsSync(u.run)) fail(`${u.id}'s worktree is gone: the units were merged, or the run was cleaned up`);
  const r = spawnSync(process.execPath, [SCRIPT, command, u.run, ...rest.filter((_, i) => i !== unitAt && i !== unitAt + 1)], { cwd: u.root, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
switch (command) {
  case "_abort": {
    // Stops a unit's run: its call, if one is running, and the run itself.
    const runDir = runDirOf(runArg);
    if (!(await acquireLock(runDir, 15000))) fail("the unit's engine is busy");
    const state = load(runDir);
    if (state.inflight) {
      const base = callBase(runDir, state.inflight.id);
      await stopCallGroup(base, state.inflight.provider);
      const pid = Number(existsSync(`${base}.pid`) ? readFileSync(`${base}.pid`, "utf8") : 0);
      if (pid && pidAlive(pid)) signalGroup(pid, "SIGTERM");
      state.inflight = null;
    }
    state.stage = "aborted";
    state.blocked = null;
    timeline(state, "ENGINE", "stopped: the run it belongs to was aborted or split again");
    save(runDir, state);
    print({ action: "aborted" });
    break;
  }
  case "new":
    cmdNew(runArg);
    break;
  case "start":
    await locked(cmdStart);
    break;
  case "next": {
    const i = rest.indexOf("--wait");
    const waitSec = i >= 0 ? Number(rest[i + 1]) || 0 : 0;
    const runDir = runDirOf(runArg);
    if (!(await acquireLock(runDir, waitSec * 1000))) {
      print({ action: "running", busy: true, next: "Another DENKEN engine process is waiting on this run. Run next again with --wait." });
      break;
    }
    await next(runDir, waitSec);
    break;
  }
  case "rule":
    await locked((runDir) => cmdRule(runDir, rest));
    break;
  case "retry":
    await locked(cmdRetry);
    break;
  case "confirm":
    await locked((runDir) => cmdConfirm(runDir, rest));
    break;
  case "status":
    cmdStatus(runDirOf(runArg));
    break;
  case "tick":
    cmdTick(runDirOf(runArg), rest);
    break;
  case "request-permission":
    cmdRequestPermission(runDirOf(runArg), rest);
    break;
  case "secrets":
    await locked((runDir) => cmdSecrets(runDir, rest));
    break;
  case "grant":
  case "deny":
    await locked((runDir) => cmdPermissionDecision(runDir, rest, command));
    break;
  case "_exec":
    try {
      await execCall(runArg, rest[0]);
    } catch (e) {
      const base = callBase(runArg, rest[0]);
      let nonce = null;
      try {
        nonce = JSON.parse(readFileSync(`${base}.job.json`, "utf8")).nonce;
      } catch {}
      writeMeta(base, { status: "failed", nonce, error: `runner error: ${e.message}`, finished: now() });
    }
    break;
  default:
    fail("usage: denken.mjs <new|start|next|confirm|rule|retry|grant|deny|status|tick|request-permission> ...");
}
