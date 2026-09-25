// A unit stays inside its numbers and its scope: the engine's checks of its plan and of its changes.
import { STEP, hasItems, mapAsync } from "./lists.ts";
import { TODO_DEV, TODO_QA } from "./paths.ts";
import type { Finding } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import type { TodoItem } from "./types-todo.ts";
import { engineFinding } from "./engine-finding.ts";
import { inScope } from "./units-plan.ts";
import { namedPaths } from "./units-names.ts";
import { parseItems } from "./todo.ts";
import { readRunFile } from "./store.ts";

// The part of a unit's state its scope check needs.
interface UnitScope {
  readonly scope: readonly string[];
  readonly unit: string;
}

const RANGE_TOP = 99,
  numberOf = (key: string): number => Number(key.split("-").at(STEP)),
  rangeGaps = async (store: RunStore, file: string, prefix: "DEV" | "QA"): Promise<readonly Finding[]> => {
    const state = store.current(),
      low = state.idBase + STEP,
      high = state.idBase + RANGE_TOP,
      { items } = parseItems(await readRunFile(store.dir, file), prefix);
    return items
      .filter((item) => numberOf(item.key) < low || numberOf(item.key) > high)
      .map((item) =>
        engineFinding({
          file,
          identity: `todo-range-${item.key}`,
          problem: `${item.key} is outside ${state.unit}'s numbers`,
          required_change: `Number ${state.unit}'s items from ${prefix}-${low} to ${prefix}-${high}.`,
          todo: item.key,
        }),
      );
  },
  // A DEV item's names outside the unit's scope, as a gap (none when it keeps inside).
  scopeGapOf = (state: UnitScope) => async (item: TodoItem): Promise<readonly Finding[]> => {
    const names = await namedPaths(item),
      outside = names.filter((name) => !inScope(state.scope, name));
    if (!hasItems(outside)) {
      return [];
    }
    return [
      engineFinding({
        file: TODO_DEV,
        identity: `todo-scope-${item.key}`,
        problem: `${item.key} names ${outside.join(", ")}, outside ${state.unit}'s scope (${state.scope.join(", ")})`,
        required_change: "Keep the item inside the scope. If it cannot be done without changing those files, say so under Open questions: DENKEN will change the split.",
        todo: item.key,
      }),
    ];
  },
  planScopeGaps = async (store: RunStore): Promise<readonly Finding[]> => {
    const state = store.current(),
      { items } = parseItems(await readRunFile(store.dir, TODO_DEV), "DEV"),
      gaps = await mapAsync(items, scopeGapOf(state));
    return gaps.flat();
  },
  // A unit's plan stays inside its numbers and its scope.
  unitPlanGaps = async (store: RunStore): Promise<readonly Finding[]> => {
    if (!store.current().unit) {
      return [];
    }
    return [...(await rangeGaps(store, TODO_DEV, "DEV")), ...(await rangeGaps(store, TODO_QA, "QA")), ...(await planScopeGaps(store))];
  };

export { unitPlanGaps };
