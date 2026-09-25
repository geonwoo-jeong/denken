// STARK's round: the ticks it recorded, applied to the TODO files, and recovery items it reported blocked.
import { blockedIn, fixItems } from "./todo.ts";
import type { ActiveCall } from "./types-items.ts";
import { DEV_REPORT } from "./paths.ts";
import type { RunStore } from "./types-store.ts";
import type { TickRejection } from "./types-work.ts";
import { applyTicks } from "./tick-apply.ts";
import { block } from "./blocks.ts";
import { hasItems } from "./lists.ts";
import { readRunFile } from "./store.ts";
import { timeline } from "./record-log.ts";

const reportLine = (report: string, key: string): string => (report.split("\n").find((line) => blockedIn(line, key)) ?? "").trim(),
  // STARK's recorded ticks, written into the TODO files; the records the engine refuses come back.
  takeTicks = async (store: RunStore, call: ActiveCall): Promise<readonly TickRejection[]> => {
    if (call.stage !== "dev") {
      return [];
    }
    const { applied, rejected } = await applyTicks(store, call);
    if (hasItems(applied)) {
      await timeline(store, call.role.toUpperCase(), `ticked ${applied.map((entry) => entry.item).join(", ")}, each with its test run and evidence`);
    }
    if (hasItems(rejected)) {
      await timeline(store, "ENGINE", `tick record(s) not accepted: ${rejected.map((rejection) => `${rejection.item} (${rejection.problem})`).join("; ")}`);
    }
    return rejected;
  },
  // A recovery item STARK reports blocked needs a decision above STARK's head.
  fixBlocked = async (store: RunStore, call: ActiveCall): Promise<boolean> => {
    const state = store.current(),
      report = await readRunFile(store.dir, DEV_REPORT),
      fixes = await fixItems(store.dir),
      stuck = fixes.filter((item) => item.cycle === state.currentFixCycle && !item.done && blockedIn(report, item.key));
    if (call.stage !== "dev" || state.devInput !== "qa" || !hasItems(stuck)) {
      return false;
    }
    await timeline(store, call.role.toUpperCase(), `reported recovery item(s) blocked: ${stuck.map((item) => item.key).join(", ")}`);
    block(store, "ruling", {
      info: { items: stuck.map((item) => ({ item: item.key, report: reportLine(report, item.key), text: item.text })), rule: "a recovery item reported blocked", stage: "dev" },
      reason: "fix_blocked",
    });
    return true;
  };

export { fixBlocked, takeTicks };
