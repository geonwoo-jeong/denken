/*
 * After STARK's call: every DEV item, and every FIX item of the current QA cycle, is either ticked
 * off with evidence and a passing test run recorded since it was last unticked, or reported blocked
 * in dev-report.md. The rest go back to STARK, with the reason a recorded tick was refused.
 */
import { DEV_REPORT, TODO_DEV, TODO_FIX } from "./paths.ts";
import { blockedIn, fixItems, parseItems } from "./todo.ts";
import type { Finding } from "./types-items.ts";
import { NONE } from "./lists.ts";
import type { PlacedItem } from "./types-partc.ts";
import type { RunStore } from "./types-store.ts";
import type { TickRejection } from "./types-work.ts";
import { readRunFile } from "./store.ts";

const problemOf = (placed: PlacedItem, rejected: readonly TickRejection[]): string => {
    const { key } = placed.item,
      refused = rejected.find((rejection) => rejection.item === key);
    if (refused) {
      return `${key}'s recorded tick was not accepted: ${refused.problem}`;
    }
    return `${key} is neither ticked off nor reported blocked in dev-report.md`;
  },
  gapOf = (placed: PlacedItem, rejected: readonly TickRejection[]): Finding => ({
    file: placed.file,
    identity: placed.item.key,
    line_end: NONE,
    line_start: NONE,
    problem: problemOf(placed, rejected),
    request_item: placed.item.refs.find((ref) => ref.startsWith("REQ-")) ?? "",
    required_change: `Finish ${placed.item.key} and tick it off with the tick command and its evidence, or report "${placed.item.key} blocked: <reason>" in dev-report.md.`,
    severity: "blocking",
    source: "engine",
    todo: placed.item.key,
    topic: placed.item.key,
  }),
  placedItems = async (store: RunStore): Promise<readonly PlacedItem[]> => {
    const devText = await readRunFile(store.dir, TODO_DEV),
      fixes = await fixItems(store.dir),
      { currentFixCycle } = store.current();
    return [
      ...parseItems(devText, "DEV").items.map((item) => ({ file: TODO_DEV, item })),
      ...fixes.filter((fix) => fix.cycle === currentFixCycle).map((item) => ({ file: TODO_FIX, item })),
    ];
  },
  devGaps = async (store: RunStore, rejected: readonly TickRejection[]): Promise<readonly Finding[]> => {
    const report = await readRunFile(store.dir, DEV_REPORT),
      items = await placedItems(store);
    return items.filter((placed) => !placed.item.done && !blockedIn(report, placed.item.key)).map((placed) => gapOf(placed, rejected));
  };

export { devGaps };
