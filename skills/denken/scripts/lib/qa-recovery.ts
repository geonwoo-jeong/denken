/*
 * The recovery TODO: STARK sees what broke and how to reproduce it, not the QA TODO list. The dev
 * stage's diff base is kept, so the next review sees every change since development began.
 */
import { appendRecovery, logRecovery } from "./qa-recovery-log.ts";
import { decrement, increment, withEntry } from "./lists.ts";
import { framed, now, oneLine, pad } from "./text.ts";
import type { ActiveCall } from "./types-items.ts";
import type { QaItem } from "./types-call.ts";
import type { QaView } from "./types-qa.ts";
import type { RunStore } from "./types-store.ts";
import { changeTree } from "./changes.ts";

const KEY_WIDTH = 3,
  TEXT_MAX = 400,
  lineOf = (view: QaView, item: QaItem, key: string): string =>
    `- [ ] ${key} (${[item.id, ...view.reqsOf(item)].join(", ")}) Fix: ${oneLine(item.check, TEXT_MAX)}. Observed: ${oneLine(item.evidence, TEXT_MAX)}.${framed(" Reproduce: ", oneLine(item.reproduce, TEXT_MAX), ".")}`,
  writeRecovery = async (store: RunStore, view: QaView, call: ActiveCall): Promise<void> => {
    const state = store.current(),
      cycle = state.round.qa,
      first = increment(state.fixCount),
      keys = view.failing.map((_item, index) => `FIX-${pad(first + index, KEY_WIDTH)}`),
      lines = view.failing.map((item, index) => lineOf(view, item, keys[index] ?? "")),
      tree = await changeTree(state);
    await appendRecovery(store.dir, { cycle, keys, lines });
    store.apply({ currentFixCycle: cycle, fixCount: decrement(first + view.failing.length), fixCycles: withEntry(store.current().fixCycles, String(cycle), { at: now(), items: keys, qa: call.id, tree }) });
    await logRecovery(store, { cycle, keys, lines });
  };

export { writeRecovery };
