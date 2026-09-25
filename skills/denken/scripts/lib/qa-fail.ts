// A failed QA cycle sends the run back to development: recovery items written, DEV items unticked, failures counted.
import type { QaResult } from "./types-ingest.ts";
import type { QaView } from "./types-qa.ts";
import type { RunStore } from "./types-store.ts";
import { noteFailures } from "./qa-failures.ts";
import { patch } from "./lists.ts";
import { untickFailing } from "./qa-ticks.ts";
import { writeRecovery } from "./qa-recovery.ts";

const failQa = async (store: RunStore, result: QaResult, view: QaView): Promise<void> => {
  const cycle = store.current().round.qa;
  await writeRecovery(store, view, result.call);
  await untickFailing(store, view, cycle);
  store.apply({ approved: patch(store.current().approved, { dev: "" }), devInput: "qa", pending: "work", stage: "dev" });
  noteFailures(store, view, result.call);
};

export { failQa };
