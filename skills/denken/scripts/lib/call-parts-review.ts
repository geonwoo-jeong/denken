// What a reviewer reads and is told: the request, the work, the diff since the stage began, and the stage's history.
import { REQUEST, TODO_DEV, TODO_FIX } from "./paths.ts";
import { denialsNote, dismissedNote, topicsNote } from "./call-topics.ts";
import type { CallParts } from "./types-calls.ts";
import type { CallSpec } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { artifactsOf } from "./stage-table.ts";
import { diffReads } from "./call-diff.ts";
import { onlyIf } from "./lists.ts";
import path from "node:path";
import { reviewNotes } from "./call-review-notes.ts";

const reviewParts = async (store: RunStore, call: CallSpec & { readonly id: string }): Promise<CallParts> => {
    const state = store.current(),
      inRun = (name: string): string => path.join(store.dir, name),
      lastReview = state.lastReview[call.stage],
      fixing = call.stage === "dev" && state.devInput === "qa";
    return {
      extra: [...(await reviewNotes(store, call)), ...topicsNote(state, call.stage), ...dismissedNote(state, call.stage), ...denialsNote(state, call.stage)],
      read: [
        inRun(REQUEST),
        ...onlyIf(call.stage === "dev", [inRun(TODO_DEV)]),
        ...artifactsOf(call.stage).map((name) => inRun(name)),
        ...(await diffReads(store, call)),
        ...onlyIf(Boolean(lastReview), [lastReview]),
        ...onlyIf(fixing, [inRun(TODO_FIX)]),
      ],
      write: [],
    };
  };

export { reviewParts };
