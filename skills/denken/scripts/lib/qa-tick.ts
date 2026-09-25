// Each checked QA item is ticked in todo-qa.md with GENAU's evidence: the QA list records what was verified.
import type { ActiveCall } from "./types-items.ts";
import type { QaItem } from "./types-call.ts";
import type { QaView } from "./types-qa.ts";
import type { RunStore } from "./types-store.ts";
import { eachInOrder } from "./lists.ts";
import { framed } from "./text.ts";
import { setTick } from "./ticks.ts";

const evidenceOf = (item: QaItem, call: ActiveCall): string => {
    if (item.result !== "PASS") {
      return "";
    }
    return `${item.evidence} (verified by: ${framed("", item.how_verified, "; ")}${call.id})`;
  },
  tickQaItems = async (store: RunStore, view: QaView, call: ActiveCall): Promise<void> => {
    await eachInOrder(view.items, async (item) => {
      await setTick(store.dir, { evidence: evidenceOf(item, call), key: item.id, prefix: "QA", ticked: item.result === "PASS" });
    });
  };

export { tickQaItems };
