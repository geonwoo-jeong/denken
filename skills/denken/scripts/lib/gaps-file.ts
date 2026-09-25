/*
 * The engine's findings sent back to the worker: a review file (calls/<call>.gaps.json) the worker
 * reads as its round's review, a step in the record, and a RETURNED verdict.
 */
import type { Call, Finding } from "./types-items.ts";
import { STAGE_NAME, verdict } from "./record-verdicts.ts";
import { logStep, timeline } from "./record-log.ts";
import type { RunStore } from "./types-store.ts";
import { callBase } from "./paths.ts";
import { oneLine } from "./text.ts";
import { patch } from "./lists.ts";
import { renderFindings } from "./render.ts";
import { toJson } from "./json.ts";
import { writeText } from "./files.ts";

// The engine's check: what it checked, and the gaps it found.
interface EngineReview {
  readonly checked: string;
  readonly gaps: readonly Finding[];
}

const PROBLEM_MAX = 120,
  // The engine's review becomes the stage's last review: the worker reads it in its next round.
  markReturned = async (store: RunStore, call: Call, review: EngineReview): Promise<void> => {
    const file = `${callBase(store.dir, call.id)}.gaps.json`;
    await writeText(file, toJson({ checked: [review.checked], findings: review.gaps, verdict: "CHANGES_REQUESTED" }));
    store.apply({ lastReview: patch(store.current().lastReview, { [call.stage]: file }) });
    if (call.stage === "dev") {
      store.apply({ devInput: "review" });
    }
  },
  logReturned = async (store: RunStore, call: Call, review: EngineReview): Promise<void> => {
    const [problem = ""] = review.gaps.map((gap) => gap.problem),
      content = renderFindings(`ENGINE · ${review.checked}`, { checked: [review.checked], findings: review.gaps, summary: "" }, { note: "", word: "" }),
      file = await logStep(store, { content, name: `engine-check-round${call.round}`, stage: call.stage });
    await timeline(store, "ENGINE", `${review.gaps.length} problem(s) found by the engine → back to ${call.role.toUpperCase()} without a review: ${oneLine(problem, PROBLEM_MAX)} → ${file}`);
    await verdict(store, { call: call.id, file, label: `${STAGE_NAME[call.stage]} check, round ${call.round}`, text: review.gaps.map((gap) => gap.problem).join("; "), who: "ENGINE", word: "RETURNED" });
  },
  returnGaps = async (store: RunStore, call: Call, review: EngineReview): Promise<void> => {
    await markReturned(store, call, review);
    await logReturned(store, call, review);
  };

export { returnGaps };
