/*
 * The checkboxes must stay truthful: DEV items serving a failing request item are unticked, and
 * need fresh evidence and a passing test run to be ticked again.
 */
import { eachInOrder, withEntry } from "./lists.ts";
import type { QaView } from "./types-qa.ts";
import type { RunStore } from "./types-store.ts";
import { TODO_DEV } from "./paths.ts";
import { changeTree } from "./changes.ts";
import { now } from "./text.ts";
import { parseItems } from "./todo.ts";
import { readRunFile } from "./store.ts";
import { setTick } from "./ticks.ts";

const noteUntick = async (store: RunStore, key: string, cycle: number): Promise<void> => {
    const tree = await changeTree(store.current());
    store.apply({ unticked: withEntry(store.current().unticked, key, { at: now(), cycle, tree }) });
  },
  untickFailing = async (store: RunStore, view: QaView, cycle: number): Promise<void> => {
    const failingReqs = new Set(view.failing.flatMap((item) => view.reqsOf(item))),
      { items } = parseItems(await readRunFile(store.dir, TODO_DEV), "DEV"),
      serving = items.filter((item) => item.done && item.refs.some((ref) => failingReqs.has(ref)));
    await eachInOrder(serving, async (item) => {
      if (await setTick(store.dir, { evidence: "", key: item.key, prefix: "DEV", ticked: false })) {
        await noteUntick(store, item.key, cycle);
      }
    });
  };

export { untickFailing };
