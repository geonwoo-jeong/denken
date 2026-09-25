// The user's first confirmation of every unit's TODO lists, passed to each unit's run.
import { fail, print } from "./output.ts";
import { hasItems, mapInOrder } from "./lists.ts";
import { now, oneLine } from "./text.ts";
import type { RunStore } from "./types-store.ts";
import type { UnitEntry } from "./types-progress.ts";
import { assertLock } from "./lock.ts";
import { confirmUnit } from "./units-entries.ts";
import { stringsOf } from "./json.ts";
import { timeline } from "./record-log.ts";
import { unblock } from "./blocks.ts";

const SAID_MAX = 140,
  openQuestionsOf = (units: readonly UnitEntry[]): readonly string[] =>
    units.flatMap((unit) => stringsOf(unit.last, "openQuestions").map((question) => `${unit.id}: ${question}`)),
  // Units that were confirmed go ahead; any that were not are then confirmed one by one.
  noteConfirmed = async (store: RunStore, userSaid: string): Promise<void> => {
    store.apply({ unitsConfirmed: { at: now(), userSaid } });
    unblock(store);
    await timeline(store, "USER via DENKEN", `confirmed the units' TODO lists: "${oneLine(userSaid, SAID_MAX)}"`);
    await timeline(store, "RESUME", "the units start development");
  },
  checkConfirmable = (store: RunStore): void => {
    const { blocked, units } = store.current(),
      questions = openQuestionsOf(units);
    if (blocked.reason !== "confirm_todos") {
      fail("nothing to confirm: the units are not all waiting for confirmation; run next");
    }
    if (hasItems(questions)) {
      fail(`cannot confirm while units have open questions: ${questions.join("; ")}. Ask the user, then replan those units with rule --unit <id> --decision replan.`);
    }
  },
  confirmUnits = async (store: RunStore, userSaid: string): Promise<void> => {
    checkConfirmable(store);
    const { units } = store.current(),
      answers = await mapInOrder(units, confirmUnit(userSaid)),
      failed = answers.filter(Boolean);
    if (failed.length < units.length) {
      await noteConfirmed(store, userSaid);
    }
    await assertLock();
    await store.save();
    if (hasItems(failed)) {
      fail(`not confirmed: ${failed.join("; ")}`);
    }
    print({ action: "confirmed", next: "Development starts in every unit. Run next with --wait.", units: units.map((unit) => unit.id) });
  };

export { confirmUnits };
