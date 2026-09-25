// Splitting a request into units: units.md, each unit's worktree and run, and the checks that keep a unit in its scope.
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LEVELS } from "../config.mjs";
import { stageChanges } from "./changes.mjs";
import { EXCLUDE, fail, now, REQUEST, ROOT, sha, slug, TODO_DEV, TODO_QA, UNITS } from "./core.mjs";
import { gitAt, gitText } from "./git.mjs";
import { projectPrint } from "./guard.mjs";
import { CHECKS, rolesOf } from "./levels.mjs";
import { logDir, logRequest, timeline } from "./record.mjs";
import { parseRequest, section } from "./request.mjs";
import { enterStage } from "./stages.mjs";
import { readRunFile, runFields, save } from "./state.mjs";
import { EVIDENCE_LINE, parseItems } from "./todo.mjs";

export const MAX_UNITS = 9;
export function parseUnits(text) {
  const units = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*[-*]\s*[*_`]*(UNIT-(\d+))\b[*_`]*\s*\(([^)]*)\)\s*(.*)$/);
    if (!m) continue;
    const [, id, n, refs, rest] = m;
    const part = (label) => rest.match(new RegExp(`\\b${label}:\\s*(.*?)(?=\\b(?:Scope|Levels?):|$)`, "i"))?.[1] ?? "";
    units.push({
      id,
      n: Number(n),
      reqs: refs.match(/\bREQ-\d{3,}\b/g) ?? [],
      title: rest.split(/\b(?:Scope|Levels?):/i)[0].trim().replace(/[.\s]+$/, ""),
      scope: [...part("Scope").matchAll(/`([^`]+)`/g)].map((x) => x[1].trim()),
      // "Levels: dev=heavy, qa=standard": this unit's levels, over the run's.
      levelPairs: [...part("Levels?").matchAll(/([a-z]+)=([a-z]+)/g)].map((x) => [x[1], x[2]]),
    });
  }
  return units;
}
// A scope entry is a directory ("src/a/", or a name without an extension) or a file.
export const scopeDir = (entry) => entry.endsWith("/") || !/\.\w+$/.test(basename(entry));
export const inScope = (scope, file) => scope.some((e) => (scopeDir(e) ? file.startsWith(`${e.replace(/\/$/, "")}/`) : file === e));
export const scopesOverlap = (a, b) => {
  const x = a.replace(/\/$/, "");
  const y = b.replace(/\/$/, "");
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`);
};
export function unitsProblems(runDir) {
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
    u.levels = {};
    for (const [key, value] of u.levelPairs) {
      const roles = rolesOf(key);
      if (!roles || !LEVELS.includes(value)) problems.push(`${u.id}: "${key}=${value}" is not a level; use <stage or role>=<${LEVELS.join("|")}>`);
      else if (value === "light" && roles.every((r) => CHECKS[r])) problems.push(`${u.id}: ${key} checks other work, and a checker never runs below standard`);
      else for (const r of roles) if (!(value === "light" && CHECKS[r])) u.levels[r] = value;
    }
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
export const WORKTREES = process.env.DENKEN_WORKTREES || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "denken", "worktrees");
// Dependencies installed in the project, linked one level above the units' worktrees, where
// module resolution finds them and git in the worktree does not see them.
export const SHARED_DEPS = ["node_modules"];

// The commit every unit starts from: the project as it is now, uncommitted and untracked files
// included, built with plumbing (a temporary index, write-tree, commit-tree), so no hook runs and
// no branch, index or working file of the project changes.
export function unitBaseCommit(runDir) {
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
export function addWorktree(path, commit) {
  mkdirSync(dirname(path), { recursive: true });
  const r = gitAt(ROOT, ["worktree", "add", "--detach", path, commit]);
  if (!r.ok) fail(`git worktree add failed for ${path}: ${r.err}`);
  // A locked worktree survives "git worktree prune" while its unit works in it.
  gitAt(ROOT, ["worktree", "lock", "--reason", "DENKEN unit in progress", path]);
}
export function removeWorktree(path) {
  if (existsSync(path)) gitAt(ROOT, ["worktree", "remove", "--force", "--force", path]);
  rmSync(path, { recursive: true, force: true });
}

// A unit's request.md: the request narrowed to the unit's REQ items, with everything that bounds
// it (out of scope, not now, cautions) and a Unit section: its scope, its numbers, and the units
// built beside it.
export function unitRequest(runDir, unit, units) {
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

// One worktree and one run per unit, all from the same base commit. The parent keeps where each
// unit lives: commands for a unit go through the parent (--unit), never by what the unit's own
// files claim.
export function createUnits(runDir, state, units) {
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
    const child = { version: 1, task: `${state.task} · ${u.id}`, created: now(), log: logDir(state), verdicts: [], unit: u.id, title: u.title, mainRoot: ROOT, idBase: u.n * 100, scope: u.scope, ...runFields(state.assignment, base), levels: { ...state.levels, ...u.levels }, overrides: state.overrides ?? {}, seeding: state.seeding ?? [] };
    enterStage(child, "plan");
    logRequest(child, run);
    timeline(child, "DENKEN", `${u.id} (${u.reqs.join(", ")}) "${u.title}" starts in its own worktree; scope ${u.scope.join(", ")}`);
    save(run, child);
    return { id: u.id, n: u.n, title: u.title, reqs: u.reqs, scope: u.scope, levels: u.levels, root: realpathSync(root), run: realpathSync(run), started: false, status: "queued", last: null, pulled: 0 };
  });
  state.mainPrint = projectPrint(runDir);
}
export function tearDownUnits(state) {
  for (const u of state.units ?? []) removeWorktree(u.root);
  if (state.unitHome) removeWorktree(join(state.unitHome, "INTEGRATION"));
  gitAt(ROOT, ["worktree", "prune"]);
}

// A unit's plan stays inside its numbers and its scope.
export function unitPlanGaps(runDir, state) {
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
export function namedPaths(item) {
  const text = item.block.split("\n").filter((l) => !EVIDENCE_LINE.test(l)).join(" ");
  const listed = (text.match(/\bFiles:\s*(.*?)(?:\.\s+[A-Z]|\bUnit tests:|$)/)?.[1] ?? "").split(/[\s,;()]+/);
  const quoted = [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((t) => t.includes("/"));
  return [...new Set([...listed, ...quoted].map((t) => t.replace(/^[`'"]+|[`'".:]+$/g, "")))]
    .filter((t) => /^[\w@.\/-]+$/.test(t) && !t.startsWith("/") && !t.includes("..") && (t.includes("/") || /\.\w+$/.test(t)))
    .filter((t) => existsSync(join(ROOT, t)) || (dirname(t) !== "." && existsSync(join(ROOT, dirname(t)))));
}
// A unit changes only files in its scope: anything else could collide with another unit.
export function unitScopeGaps(state) {
  if (!state.unit) return [];
  return stageChanges(state, "dev").changed.filter((f) => !inScope(state.scope, f)).map((f) => ({
    identity: `scope-${f}`, severity: "blocking", topic: `scope-${f}`, file: f, line_start: null, line_end: null, request_item: null, todo: null, source: "engine",
    problem: `${f} changed, outside ${state.unit}'s scope (${state.scope.join(", ")})`,
    required_change: `Undo the change to ${f}. If an item cannot be done without it, report the item blocked in dev-report.md with the reason: DENKEN will change the split.`,
  }));
}
