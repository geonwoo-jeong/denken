/*
 * Taking in a finished call's result. The prelude is the same for every call: record it, note its
 * seed and session, and stop on a violation, a permission request or a failure. Then the result goes
 * to the handler for the call's kind: work, review or QA.
 */
import { checkedMeta, recordResult } from "./ingest-record.ts";
import { noteContinuation, noteSeed, noteSession } from "./ingest-seed.ts";
import type { ActiveCall } from "./types-items.ts";
import type { Meta } from "./types-call.ts";
import { NO_CALL } from "./state-zero.ts";
import type { RunStore } from "./types-store.ts";
import { ingestChecker } from "./ingest-checker.ts";
import { ingestWork } from "./ingest-work.ts";
import { logRaw } from "./record-files.ts";
import { stopsHere } from "./ingest-stop.ts";

const settle = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<void> => {
    await recordResult(store, call, meta);
    if (await stopsHere(store, call, meta)) {
      return;
    }
    noteSession(store, call, meta);
    if (call.mode === "work") {
      await ingestWork(store, call, meta);
      return;
    }
    await ingestChecker(store, call, meta);
  },
  ingest = async (store: RunStore, meta: Meta): Promise<void> => {
    const { inflight } = store.current();
    if (inflight.kind === "none") {
      return;
    }
    store.apply({ inflight: NO_CALL });
    await logRaw(store, inflight.id);
    await noteSeed(store, inflight, meta);
    await noteContinuation(store, inflight, meta);
    await settle(store, inflight, await checkedMeta(store, inflight, meta));
  };

export { ingest };
