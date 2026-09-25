/*
 * GENAU's QA report. Every QA item must be reported, and one that is missing counts as failed. A
 * pass approves QA; a failure goes back to development with a recovery TODO written from the
 * evidence, and the DEV items serving the failing request items are unticked.
 */
import type { QaResult } from "./types-ingest.ts";
import type { RunStore } from "./types-store.ts";
import { approve } from "./stage-approve.ts";
import { failQa } from "./qa-fail.ts";
import { isEmpty } from "./lists.ts";
import { logQa } from "./record-qa.ts";
import { logQaOutcome } from "./qa-outcome.ts";
import { qaResults } from "./qa-results.ts";
import { tickQaItems } from "./qa-tick.ts";

const ingestQa = async (store: RunStore, result: QaResult): Promise<void> => {
  const view = await qaResults(store, result.output);
  store.apply({ lastQa: result.outPath });
  await tickQaItems(store, view, result.call);
  await logQa(store, { call: result.call, facts: result.meta.facts, items: view.items });
  await logQaOutcome(store, result, view);
  if (isEmpty(view.failing)) {
    await approve(store, "qa", result.outPath);
    return;
  }
  await failQa(store, result, view);
};

export { ingestQa };
