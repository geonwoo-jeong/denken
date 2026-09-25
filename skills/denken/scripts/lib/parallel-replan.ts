// A new split, made while every unit still waits for its first confirmation: the old units stop, new ones start.
import type { RunStore } from "./types-store.ts";
import { UNITS } from "./paths.ts";
import { abortUnits } from "./parallel-abort.ts";
import { createUnits } from "./units-create.ts";
import { fail } from "./output.ts";
import { hasItems } from "./lists.ts";
import { logRequest } from "./record-files.ts";
import { splitCheck } from "./units-plan.ts";
import { unblock } from "./blocks.ts";

const replanUnits = async (store: RunStore): Promise<void> => {
  const { blocked, unitsConfirmed } = store.current(),
    check = await splitCheck(store.dir),
    { problems } = check;
  if (blocked.reason !== "confirm_todos" || unitsConfirmed.at) {
    fail("the split can change only while every unit waits for the first confirmation; to replan one unit, use --unit <id>");
  }
  if (hasItems(problems)) {
    fail(`fix request.md and ${UNITS} before splitting again: ${problems.join("; ")}`);
  }
  await abortUnits(store);
  await createUnits(store, check.units);
  await logRequest(store);
  unblock(store);
};

export { replanUnits };
