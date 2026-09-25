// What a call may change: snapshots of the project and of DENKEN's own files, and undoing changes to the latter.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DENKEN_DIR, EXCLUDE, hashFile, listFiles, ROOT, sha, SKILL_DIR } from "./core.mjs";
import { git } from "./git.mjs";

// Files that configure the agents, and DENKEN's own skill: a call that changed them could plant
// hooks, MCP servers or instructions that the next call (a reviewer's, say) would then load.
// They belong to DENKEN for the whole run: a change is undone and recorded.
export const AGENT_CONTEXT = /(^|\/)(CLAUDE|CLAUDE\.local|AGENTS)\.md$|^\.(claude|codex|agents|cursor|gemini)\/|^\.mcp\.json$/;

export function agentConfigFiles() {
  const files = new Set();
  for (const dir of [".claude", ".codex", ".agents", ".cursor", ".gemini"]) for (const p of listFiles(join(ROOT, dir))) files.add(p);
  if (existsSync(join(ROOT, ".mcp.json"))) files.add(join(ROOT, ".mcp.json"));
  for (const f of git("ls-files", "--cached", "--others", "--exclude-standard", "-z").toString().split("\0")) {
    if (f && /(^|\/)(CLAUDE|CLAUDE\.local|AGENTS)\.md$/.test(f)) files.add(join(ROOT, f));
  }
  for (const p of listFiles(SKILL_DIR)) files.add(p);
  return [...files];
}

export function snapshot(runDir, callId, logPath) {
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
export function violations(before, after, guard, runDir, pinned, callId) {
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

export function pinOwned(owned) {
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

// The project as the units found it: tracked, untracked and ignored files and agent
// configuration, without DENKEN's own run and record. It must not change while units work.
export function projectPrint(runDir) {
  const s = snapshot(runDir, "", null);
  const mine = `${relative(ROOT, runDir)}/`;
  return sha(JSON.stringify([s.project, s.ignored, Object.entries(s.owned).filter(([f]) => !f.startsWith(mine))]));
}
