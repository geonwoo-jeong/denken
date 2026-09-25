// Paths, file names, stage tables and small helpers every module uses. It imports nothing from the engine, so any module can use it.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The engine's entry point: calls and units start it again as a separate process.
export const SCRIPT = join(SKILL_DIR, "scripts", "denken.mjs");
export const ROOT = process.cwd();
export const DENKEN_DIR = join(ROOT, ".denken");
// DENKEN's own trees: never part of the project as far as guards, diffs and scope are concerned.
export const EXCLUDE = [":(exclude).denken", ":(exclude)ai-log"];
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const NEXT_STAGE = { plan: "dev", dev: "qa", qa: "wiki", wiki: "done" };
export const WORKER = { plan: "methode", dev: "stark", wiki: "serie" };
export const REVIEWER = { plan: "richter", dev: "ubel", wiki: "frieren" };
export const REQUEST = "request.md";
export const TODO_DEV = "todo-dev.md";
export const TODO_QA = "todo-qa.md";
export const TODO_FIX = "todo-fix.md";
export const ARTIFACTS = { plan: [TODO_DEV, TODO_QA], dev: ["dev-report.md"], wiki: ["wiki-report.md"] };
export const PERMISSION_ASKS_PER_ROLE = 5;
export const PERMISSION_ATTEMPTS_PER_CALL = 3;
export const USAGE_LIMIT = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/i;

// ---------- helpers

export const print = (value) => console.log(JSON.stringify(value, null, 2));
export function fail(message) {
  print({ action: "error", error: message });
  process.exit(1);
}
export const sha = (data) => createHash("sha256").update(data).digest("hex");
export const hashFile = (path) => {
  try {
    return sha(readFileSync(path));
  } catch {
    return "missing";
  }
};
export const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
export const now = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// ---------- state

// ---------- units: one request built in parallel
// units.md, DENKEN's optional split of the request into units that are built at the same time:
//   - UNIT-1 (REQ-001, REQ-002) <title>. Scope: `src/a/`, `test/a/`.
// Each unit gets its own git worktree and runs plan, dev (with review) and QA there; when every
// unit is done, the engine merges them and verifies the whole again. Work whose scope or
// dependencies overlap is not split: it belongs in one unit, where its items run in order.
export const UNITS = "units.md";
export const clock = () => new Date().toTimeString().slice(0, 8);
export const pad = (n, width) => String(n).padStart(width, "0");
export const oneLine = (text, max = 200) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
