/*
 * QA's failures in the development stage's record: each failing item counts toward its identity's
 * repeats. The engine can write a recovery TODO, but it cannot find a root cause: the same failure in
 * two QA cycles in a row goes to DENKEN instead of producing yet another FIX item.
 */
import type { ActiveCall, StoredFinding } from "./types-items.ts";
import { NONE, STEP, hasItems, increment, patch } from "./lists.ts";
import type { QaItem } from "./types-call.ts";
import type { QaView } from "./types-qa.ts";
import type { RunStore } from "./types-store.ts";
import { TODO_FIX } from "./paths.ts";
import { block } from "./blocks.ts";
import { checkThresholds } from "./findings.ts";
import path from "node:path";

const findingOf = (view: QaView, item: QaItem, round: number): StoredFinding => {
    const identity = view.identityOf(item),
      [request = ""] = view.reqsOf(item);
    return {
      call: "",
      file: "",
      identity,
      line_end: NONE,
      line_start: NONE,
      problem: `QA failed ${item.id}: ${item.check}`,
      request_item: request,
      required_change: item.reproduce || item.evidence,
      round,
      severity: "blocking",
      source: "",
      stage: "dev",
      todo: item.id,
      topic: identity,
    };
  },
  countsAfter = (counts: Readonly<Record<string, number>>, identities: readonly string[]): Readonly<Record<string, number>> => {
    const next: Record<string, number> = Object.fromEntries(Object.entries(counts));
    for (const identity of identities) {
      next[identity] = increment(next[identity] ?? NONE);
    }
    return next;
  },
  noteFailures = (store: RunStore, view: QaView, call: ActiveCall): void => {
    const state = store.current(),
      identities = view.failing.map((item) => view.identityOf(item)),
      repeated = identities.filter((identity) => state.lastQaFailing.includes(identity)),
      stored = view.failing.map((item) => Object.assign(findingOf(view, item, state.round.dev), { call: call.id }));
    store.apply({
      counts: patch(state.counts, { dev: countsAfter(state.counts.dev, identities) }),
      findings: patch(state.findings, { dev: [...state.findings.dev, ...stored] }),
      lastQaFailing: identities,
    });
    if (hasItems(repeated)) {
      block(store, "ruling", {
        info: { cycles: [call.round - STEP, call.round], identities: repeated, recovery: path.join(store.dir, TODO_FIX), rule: "the same failure in two QA cycles in a row", stage: "dev" },
        reason: "qa_repeated_failure",
      });
      return;
    }
    checkThresholds(store, "dev");
  };

export { noteFailures };
