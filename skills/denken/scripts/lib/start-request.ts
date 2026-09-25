// Start's first checks: the run is new, request.md is complete, and the project is a git work tree.
import { REQUEST } from "./paths.ts";
import type { RunStore } from "./types-store.ts";
import { fail } from "./output.ts";
import { gitText } from "./git.ts";
import { hasItems } from "./lists.ts";
import { readRunFile } from "./store.ts";
import { requestProblems } from "./request.ts";

const checkRequest = async (store: RunStore): Promise<void> => {
  const { stage } = store.current(),
    problems = requestProblems(await readRunFile(store.dir, REQUEST));
  if (stage !== "intake") {
    fail(`run already started (stage: ${stage})`);
  }
  if (hasItems(problems)) {
    fail(problems.join("; "));
  }
  if ((await gitText(["rev-parse", "--is-inside-work-tree"])) !== "true") {
    fail("DENKEN needs a git work tree to detect file changes; run git init first");
  }
};

export { checkRequest };
