// What the user's confirmation needs: the run waits for it, what changed was reviewed, the plan is sound, and no question is open.
import { confirmedHashes, openQuestions } from "./todo.ts";
import { requestProblems, reusedIds } from "./request.ts";
import { REQUEST } from "./paths.ts";
import type { RunStore } from "./types-store.ts";
import { fail } from "./output.ts";
import { hasItems } from "./lists.ts";
import { readRunFile } from "./store.ts";
import { todoGaps } from "./todo-gaps.ts";
import { unitPlanGaps } from "./units-gaps.ts";

const checkWaiting = async (store: RunStore): Promise<void> => {
    const { blocked, confirmed } = store.current(),
      current = await confirmedHashes(store.dir),
      reviewed = (["request", "todoDev"] as const).filter((key) => current[key] !== confirmed.hashes[key]);
    if (blocked.reason !== "confirm_todos" && blocked.reason !== "scope_changed") {
      fail("nothing to confirm: the run is not waiting for TODO confirmation");
    }
    if (blocked.reason === "scope_changed" && hasItems(reviewed)) {
      fail(`${reviewed.join(" and ")} changed since the user confirmed; no reviewer has checked the new content. Restore it, or run rule --decision replan.`);
    }
  },
  planProblems = async (store: RunStore): Promise<readonly string[]> => {
    const gaps = [...(await todoGaps(store.dir)), ...(await unitPlanGaps(store))];
    return [...requestProblems(await readRunFile(store.dir, REQUEST)), ...(await reusedIds(store)), ...gaps.map((gap) => gap.problem)];
  },
  checkConfirmable = async (store: RunStore): Promise<void> => {
    await checkWaiting(store);
    const problems = await planProblems(store),
      questions = await openQuestions(store.dir);
    if (hasItems(problems)) {
      fail(`cannot confirm: ${problems.join("; ")}. Fix request.md and replan.`);
    }
    if (hasItems(questions)) {
      fail(`cannot confirm while todo-dev.md has open questions: ${questions.join("; ")}. Ask the user, write the answers into request.md, then replan.`);
    }
  };

export { checkConfirmable };
