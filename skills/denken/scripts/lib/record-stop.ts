// Stops in the timeline: each is logged once, when the run first blocks on it.
import { framed, oneLine } from "./text.ts";
import type { BlockInfo } from "./types-block.ts";
import type { RunStore } from "./types-store.ts";
import { timeline } from "./record-log.ts";

const WHO: Readonly<Record<string, string>> = {
    permission: "DENKEN is called in to decide a permission",
    ruling: "DENKEN is called in",
    user: "waiting for the user",
  },
  detailOf = (info: BlockInfo): string =>
    [
      (info.requests ?? []).map((request) => `${request.need} (${request.why})`).join("; "),
      info.identity ?? (info.identities ?? []).join(", "),
      (info.items ?? []).map((item) => item.item).join(", "),
      (info.violations ?? []).join("; "),
      oneLine(info.error ?? ""),
      info.rule ?? "",
    ]
      .filter(Boolean)
      .join(" · "),
  logStop = async (store: RunStore): Promise<void> => {
    const { blocked, loggedBlock } = store.current();
    if (blocked.kind === "none" || loggedBlock === blocked.since) {
      return;
    }
    store.apply({ loggedBlock: blocked.since });
    await timeline(store, "STOP", `${blocked.reason}${framed(": ", detailOf(blocked.info), "")} (${WHO[blocked.kind] ?? ""})`);
  };

export { logStop };
