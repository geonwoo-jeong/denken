// Where the engine and the project are, and the names of the files a run keeps.
import path from "node:path";

const SKILL_DIR = path.join(import.meta.dirname, "..", ".."),
  // The engine's entry point: calls and units start it again as a separate process.
  SCRIPT = path.join(SKILL_DIR, "scripts", "denken.ts"),
  ROOT = process.cwd(),
  DENKEN_DIR = path.join(ROOT, ".denken"),
  // DENKEN's own trees: never part of the project as far as guards, diffs and scope are concerned.
  EXCLUDE: readonly string[] = [":(exclude).denken", ":(exclude)ai-log"],
  EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  REQUEST = "request.md",
  TODO_DEV = "todo-dev.md",
  TODO_QA = "todo-qa.md",
  TODO_FIX = "todo-fix.md",
  UNITS = "units.md",
  DEV_REPORT = "dev-report.md",
  WIKI_REPORT = "wiki-report.md",
  RULINGS = "rulings.md",
  STATE_FILE = "state.json",
  callBase = (runDir: string, id: string): string => path.join(runDir, "calls", id);

export {
  callBase,
  DENKEN_DIR,
  DEV_REPORT,
  EMPTY_TREE,
  EXCLUDE,
  REQUEST,
  ROOT,
  RULINGS,
  SCRIPT,
  SKILL_DIR,
  STATE_FILE,
  TODO_DEV,
  TODO_FIX,
  TODO_QA,
  UNITS,
  WIKI_REPORT,
};
