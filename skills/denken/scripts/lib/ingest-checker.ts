// A checker's result, to its handler: a reviewer's findings, or GENAU's QA report.
import { toQaOutput, toReviewOutput } from "./outputs.ts";
import type { ActiveCall } from "./types-items.ts";
import type { Meta } from "./types-call.ts";
import type { RunStore } from "./types-store.ts";
import { callBase } from "./paths.ts";
import { ingestQa } from "./ingest-qa.ts";
import { ingestReview } from "./ingest-review.ts";
import { parseJson } from "./json.ts";
import { ranAsItsWorker } from "./ingest-stop.ts";
import { readTextOr } from "./files.ts";

const ingestChecker = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<void> => {
  const outPath = `${callBase(store.dir, call.id)}.out.json`,
    { value } = parseJson(await readTextOr(outPath, ""));
  if (await ranAsItsWorker(store, call, meta)) {
    return;
  }
  if (call.mode === "qa") {
    await ingestQa(store, { call, meta, outPath, output: toQaOutput(value) });
    return;
  }
  await ingestReview(store, { call, meta, outPath, output: toReviewOutput(value) });
};

export { ingestChecker };
