// A review in the record: its step file (findings and call facts), its timeline line and its verdict.
import { STAGE_NAME, verdict } from "./record-verdicts.ts";
import { factsBrief, renderFacts } from "./render-facts.ts";
import { framed, oneLine } from "./text.ts";
import { logStep, timeline } from "./record-log.ts";
import type { Judged } from "./types-review.ts";
import type { ReviewResult } from "./types-ingest.ts";
import type { RunStore } from "./types-store.ts";
import { renderFindings } from "./render.ts";

const PROBLEM_MAX = 120,
  outcomeText = (judged: Judged): string => {
    const [first] = judged.open;
    if (first) {
      return `REJECTED (${judged.open.length} blocking): ${oneLine(first.problem, PROBLEM_MAX)}`;
    }
    return "APPROVED";
  },
  summaryOf = (result: ReviewResult, judged: Judged): string => {
    const [first] = judged.open;
    if (result.output.summary) {
      return result.output.summary;
    }
    if (first) {
      return first.problem;
    }
    return "no findings";
  },
  mergedText = (judged: Judged): string => {
    if (judged.merged) {
      return " of the merged units";
    }
    return "";
  },
  logReview = async (store: RunStore, result: ReviewResult, judged: Judged): Promise<void> => {
    const { call, meta, output } = result,
      who = call.role.toUpperCase(),
      content = renderFindings(`${who} · ${call.stage} review, round ${call.round} · ${call.provider}`, output, { note: judged.note, word: judged.word }) + renderFacts(meta.facts),
      file = await logStep(store, { content, name: `${call.role}-${judged.word.toLowerCase()}-round${call.round}`, stage: call.stage });
    await timeline(store, who, `${outcomeText(judged)}${framed(" (", judged.note, ")")}${factsBrief(meta.facts)} → ${file}`);
    await verdict(store, {
      call: call.id,
      file,
      label: `${STAGE_NAME[call.stage]} review${mergedText(judged)}, round ${call.round}`,
      note: judged.note,
      text: summaryOf(result, judged),
      who: `${who} (${call.provider})`,
      word: judged.word,
    });
  };

export { logReview };
