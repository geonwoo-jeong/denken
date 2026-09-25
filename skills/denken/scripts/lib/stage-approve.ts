// Approving a stage, and finishing the run: the last verdict, and the digest of the finished verdicts.md.
import type { RunStage, Stage } from "./types-names.ts";
import { enterStage, nextStageOf } from "./stages.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { block } from "./blocks.ts";
import { scanSecrets } from "./record-secrets.ts";
import { timeline } from "./record-log.ts";
import { unique } from "./lists.ts";
import { verdict } from "./record-verdicts.ts";
import { withStage } from "./stage-maps.ts";

const FIRST = 0,
  FILES_SHOWN = 5,
  finish = async (store: RunStore): Promise<void> => {
    if (store.current().unit) {
      await verdict(store, { label: "Unit", text: "planned, built, reviewed and verified on its own; it is merged when every unit is done", who: "ENGINE", word: "DONE" });
      return;
    }
    await verdict(store, { label: "Done", text: "every stage approved", who: "ENGINE", word: "DONE" });
    await timeline(store, "ENGINE", `verdicts.md sha256: ${store.current().verdictsSha}`);
  },
  // The record is tracked in the project, so likely secrets in it stop the run before DONE.
  stoppedBySecrets = async (store: RunStore, stage: Stage): Promise<boolean> => {
    const hits = await scanSecrets(store.current()),
      files = unique(hits.map((hit) => hit.file)).slice(FIRST, FILES_SHOWN);
    store.apply({ secretFindings: hits });
    if (hits.length === FIRST) {
      return false;
    }
    await timeline(store, "ENGINE", `secret scan: ${hits.length} possible secret(s) in the record (${files.join(", ")})`);
    block(store, "user", { info: { findings: hits, resolveWith: "secrets", stage }, reason: "secrets_in_record" });
    return true;
  },
  approvalNote = (state: RunState, stage: Stage, next: RunStage): string => {
    if (next !== "done") {
      return `${stage} approved → ${next}`;
    }
    if (state.unit) {
      return "DONE: planned, built, reviewed and verified; waiting for the merge";
    }
    return "DONE: every stage approved";
  },
  moveOn = async (store: RunStore, stage: Stage, next: RunStage): Promise<void> => {
    await timeline(store, "ENGINE", approvalNote(store.current(), stage, next));
    if (next === "done") {
      await finish(store);
    }
    if (stage === "dev") {
      store.apply({ devInput: "" });
    }
    await enterStage(store, next);
    // Development starts only after the user has confirmed the scope and both TODO lists.
    if (stage === "plan") {
      block(store, "user", { info: { resolveWith: "confirm", stage: "plan" }, reason: "confirm_todos" });
    }
  },
  approve = async (store: RunStore, stage: Stage, evidence: string): Promise<void> => {
    const state = store.apply({ approved: withStage(store.current().approved, stage, evidence) }),
      next = nextStageOf(state, stage);
    if (next === "done" && !state.unit && (await stoppedBySecrets(store, stage))) {
      return;
    }
    await moveOn(store, stage, next);
  };

export { approve, finish };
