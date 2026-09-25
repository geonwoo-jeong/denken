// A QA cycle's outcome in the record: its verdict (PASSED or FAILED) and its timeline line.
import { STAGE_LOG, logPart, timeline } from "./record-log.ts";
import { hasItems, isEmpty } from "./lists.ts";
import type { QaResult } from "./types-ingest.ts";
import type { QaView } from "./types-qa.ts";
import type { RunStore } from "./types-store.ts";
import { verdict } from "./record-verdicts.ts";

const summaryOf = (result: QaResult, view: QaView): string => {
    if (result.output.summary) {
      return result.output.summary;
    }
    if (hasItems(view.failing)) {
      return view.failing.map((item) => `${item.id} failed`).join(", ");
    }
    return "all checks passed";
  },
  noteOf = (result: QaResult, view: QaView): string => {
    if ((result.output.result === "PASS") === isEmpty(view.failing)) {
      return "";
    }
    return `GENAU's result: ${result.output.result}; ${view.failing.length} failing item(s) after dismissals and missing items`;
  },
  labelOf = (store: RunStore, round: number): string => {
    if (hasItems(store.current().units)) {
      return `Independent QA after the merge, cycle ${round}`;
    }
    return `Independent QA, cycle ${round}`;
  },
  lineOf = (view: QaView, round: number, folder: string): string => {
    if (hasItems(view.failing)) {
      return `FAILED QA cycle ${round}: ${view.failing.map((item) => item.id).join(", ")} → ${folder}/`;
    }
    return `PASSED QA cycle ${round} (${view.items.length} checks) → ${folder}/`;
  },
  wordOf = (view: QaView): string => {
    if (hasItems(view.failing)) {
      return "FAILED";
    }
    return "PASSED";
  },
  logQaOutcome = async (store: RunStore, result: QaResult, view: QaView): Promise<void> => {
    const { call } = result,
      folder = `${logPart(store.current(), STAGE_LOG.qa)}/qa-${call.round}`;
    await verdict(store, { call: call.id, file: `${folder}/report.md`, label: labelOf(store, call.round), note: noteOf(result, view), text: summaryOf(result, view), who: `GENAU (${call.provider})`, word: wordOf(view) });
    await timeline(store, call.role.toUpperCase(), lineOf(view, call.round, folder));
  };

export { logQaOutcome };
