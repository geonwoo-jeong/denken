// Where an item's evidence is measured from: the latest of the moments that reset it.
import type { ItemBase } from "./types-work.ts";
import type { RunState } from "./types-run.ts";

const latestBase = (bases: readonly ItemBase[]): ItemBase => {
    let latest: ItemBase = { at: "", tree: {}, what: "development began" };
    for (const base of bases) {
      if (base.at >= latest.at) {
        latest = base;
      }
    }
    return latest;
  },
  tickedBase = (state: RunState, key: string): readonly ItemBase[] => {
    const tick = state.tickBases[key];
    if (!tick) {
      return [];
    }
    return [{ at: tick.at, tree: tick.tree, what: `${key} was last ticked (${tick.call})` }];
  },
  untickedBase = (state: RunState, key: string): readonly ItemBase[] => {
    const untick = state.unticked[key];
    if (!untick) {
      return [];
    }
    return [{ at: untick.at, tree: untick.tree, what: `the engine unticked ${key} after QA failed` }];
  },
  cycleBase = (state: RunState, key: string): readonly ItemBase[] => {
    const cycle = state.fixCycles[String(state.currentFixCycle)];
    if (!key.startsWith("FIX-") || !cycle) {
      return [];
    }
    return [{ at: cycle.at, tree: cycle.tree, what: `QA cycle ${state.currentFixCycle} wrote ${key}` }];
  },
  /*
   * Where an item's evidence is measured from: whichever came last of the start of development, the
   * item's own last applied tick, the engine unticking it, and (for a FIX item) the QA cycle that
   * wrote it. All of these come from state.json, which only the engine writes.
   */
  itemBase = (state: RunState, key: string): ItemBase => {
    const start = state.stageEnteredAt.dev,
      bases = [{ at: start, tree: {}, what: "development began" }, ...tickedBase(state, key), ...untickedBase(state, key), ...cycleBase(state, key)];
    return latestBase(bases.filter((base) => base.at >= start));
  };

export { itemBase };
