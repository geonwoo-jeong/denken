// What the engine's own checks find in a worker's round, by stage.
import type { ActiveCall, Finding } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import type { TickRejection } from "./types-work.ts";
import { devGaps } from "./tick-gaps.ts";
import { todoGaps } from "./todo-gaps.ts";
import { unitPlanGaps } from "./units-gaps.ts";
import { unitScopeGaps } from "./units-scope.ts";
import { wikiGaps } from "./wiki-gaps.ts";

const CHECKED: Readonly<Record<string, string>> = {
    dev: "engine check of the TODO items' ticks and recorded test runs",
    plan: "engine check of the TODO lists against request.md",
    wiki: "engine check that only documentation changed",
  },
  stageGaps = async (store: RunStore, call: ActiveCall, rejected: readonly TickRejection[]): Promise<readonly Finding[]> => {
    if (call.stage === "plan") {
      return [...(await todoGaps(store.dir)), ...(await unitPlanGaps(store))];
    }
    if (call.stage === "dev") {
      return [...(await devGaps(store, rejected)), ...(await unitScopeGaps(store.current()))];
    }
    const gaps = await wikiGaps(store.current());
    return gaps;
  };

export { CHECKED, stageGaps };
