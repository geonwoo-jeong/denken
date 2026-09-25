// The facts a reviewer is given for its stage: UBEL's scope report, the merged units, SERIE's changes, a QA fix.
import type { CallSpec } from "./types-items.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { TODO_FIX } from "./paths.ts";
import { isDoc } from "./wiki.ts";
import { scopeReport } from "./scope.ts";
import { stageChanges } from "./changes.ts";

const mergeNote = (state: RunState): string =>
    `This is the merged result of units built in parallel, each already reviewed on its own: ${state.units
      .map((unit) => `${unit.id} "${unit.title}" (${unit.reqs.join(", ")}, in ${unit.scope.join(", ")})`)
      .join("; ")}. Review what no unit's reviewer could see: how the units fit together. Look for duplicated helpers, inconsistent names or APIs, conflicting assumptions, and a change in one unit that breaks another.`,
  wikiReviewNote = async (state: RunState): Promise<string> => {
    const { changed } = await stageChanges(state, "wiki");
    return `Code changed in this run: ${state.runChanges.filter((file) => !isDoc(file)).join(", ") || "none"}.\n  Docs changed in this stage: ${changed.join(", ") || "none"}.\n  Read the code each changed doc describes, and check that the description matches it. Flag docs changed for no reason related to these changes.`;
  },
  devNotes = async (store: RunStore): Promise<readonly string[]> => {
    const state = store.current(),
      notes = [`Scope facts computed by the engine:\n  ${await scopeReport(store)}`];
    if (state.devInput === "merge") {
      return [...notes, mergeNote(state)];
    }
    if (state.devInput === "qa") {
      return [
        ...notes,
        `This round fixes what independent QA found (QA cycle ${state.currentFixCycle} in ${TODO_FIX}). Check that each fix is general: no special-casing of the reported inputs, no hard-coded expected outputs, no weakened or deleted tests.`,
      ];
    }
    return notes;
  },
  reviewNotes = async (store: RunStore, call: CallSpec): Promise<readonly string[]> => {
    if (call.stage === "dev") {
      const notes = await devNotes(store);
      return notes;
    }
    if (call.stage === "wiki") {
      return [await wikiReviewNote(store.current())];
    }
    return [];
  };

export { reviewNotes };
