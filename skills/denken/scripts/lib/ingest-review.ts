/*
 * A reviewer's result. The stage's outcome is the engine's: the blocking findings still open after
 * DENKEN's dismissals. When the reviewer's own verdict says otherwise, the record says both.
 */
import { NONE, hasItems, patch } from "./lists.ts";
import { identityOf, recordReview } from "./findings.ts";
import type { Finding } from "./types-items.ts";
import type { Judged } from "./types-review.ts";
import type { ReviewResult } from "./types-ingest.ts";
import type { RunStore } from "./types-store.ts";
import { approve } from "./stage-approve.ts";
import { logReview } from "./ingest-log-review.ts";

const dismissedNote = (count: number): string => {
    if (count > NONE) {
      return `, ${count} already dismissed by DENKEN`;
    }
    return "";
  },
  wordOf = (open: readonly Finding[]): string => {
    if (hasItems(open)) {
      return "REJECTED";
    }
    return "APPROVED";
  },
  saidOf = (said: string): string => {
    if (said === "APPROVED") {
      return "APPROVED";
    }
    return "REJECTED";
  },
  judgeReview = (store: RunStore, result: ReviewResult): Judged => {
    const state = store.current(),
      { stage } = result.call,
      merged = stage === "dev" && state.devInput === "merge",
      raised = result.output.findings.filter((finding) => finding.severity === "blocking"),
      open = raised.filter((finding) => !state.dismissed[stage].includes(identityOf(finding, state.findings[stage]))),
      word = wordOf(open),
      said = saidOf(result.output.verdict);
    if (said === word) {
      return { merged, note: "", open, word };
    }
    return { merged, note: `reviewer's verdict: ${said}; ${open.length} open blocking finding(s)${dismissedNote(raised.length - open.length)}`, open, word };
  },
  ingestReview = async (store: RunStore, result: ReviewResult): Promise<void> => {
    const { call, outPath } = result,
      judged = judgeReview(store, result);
    store.apply({ lastReview: patch(store.current().lastReview, { [call.stage]: outPath }) });
    if (call.stage === "dev") {
      store.apply({ devInput: "review" });
    }
    await logReview(store, result, judged);
    if (recordReview(store, { call, findings: result.output.findings, stage: call.stage }) === NONE) {
      await approve(store, call.stage, outPath);
    }
  };

export { ingestReview };
