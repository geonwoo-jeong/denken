// Which call comes next: a retry DENKEN or the engine asked for, QA, the stage's worker, or its reviewer.
import type { Call, CallSpec, RetryCall } from "./types-items.ts";
import { REVIEWER, WORKER, isWorkStage } from "./stage-table.ts";
import { STEP, increment, patch } from "./lists.ts";
import { NO_CALL } from "./state-zero.ts";
import type { RunStore } from "./types-store.ts";
import { fail } from "./output.ts";
import { randomUUID } from "node:crypto";

const retried = (store: RunStore, retry: RetryCall): CallSpec => {
    store.apply({ retryCall: NO_CALL });
    return { attempt: retry.attempt, mode: retry.mode, role: retry.role, round: retry.round, stage: retry.stage };
  },
  qaCall = (store: RunStore): CallSpec => {
    const { round } = store.current(),
      next = increment(round.qa);
    store.apply({ round: patch(round, { qa: next }) });
    return { attempt: STEP, mode: "qa", role: "genau", round: next, stage: "qa" };
  },
  // A worker's call starts a new round of its stage; its reviewer checks that same round.
  stageCall = (store: RunStore): CallSpec => {
    const { pending, round, stage } = store.current();
    if (!isWorkStage(stage)) {
      return fail(`no call runs in the ${stage} stage`);
    }
    if (pending === "work") {
      store.apply({ round: patch(round, { [stage]: increment(round[stage]) }) });
      return { attempt: STEP, mode: "work", role: WORKER[stage], round: increment(round[stage]), stage };
    }
    return { attempt: STEP, mode: "review", role: REVIEWER[stage], round: round[stage], stage };
  },
  // A call gets its id from its stage, role and round, and a nonce that marks this attempt's result.
  withId = (spec: CallSpec): Call => Object.assign(structuredClone(spec), { id: `${spec.stage}-${spec.role}-${spec.round}`, nonce: randomUUID() }),
  pickCall = (store: RunStore): CallSpec => {
    const { retryCall, stage } = store.current();
    if (retryCall.kind === "retry") {
      return retried(store, retryCall);
    }
    if (stage === "qa") {
      return qaCall(store);
    }
    return stageCall(store);
  },
  nextCall = (store: RunStore): Call => withId(pickCall(store));

export { nextCall };
