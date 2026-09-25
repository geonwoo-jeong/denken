/*
 * One worktree and one run per unit, all from the same base commit. The parent keeps where each
 * unit lives: commands for a unit go through the parent (--unit), never by what the unit's own
 * files claim.
 */
import { NONE, mapInOrder } from "./lists.ts";
import { exists, makeDir, realPath, writeText } from "./files.ts";
import type { RunStore } from "./types-store.ts";
import type { UnitEntry } from "./types-progress.ts";
import type { UnitPlan } from "./types-units.ts";
import { addWorktree } from "./units-worktree.ts";
import path from "node:path";
import { prepareHome } from "./units-home.ts";
import { startUnitRun } from "./units-child.ts";
import { unitRequest } from "./units-request.ts";

interface UnitPlace {
  readonly base: string;
  readonly home: string;
  readonly units: readonly UnitPlan[];
}

const entryOf = async (unit: UnitPlan, root: string, run: string): Promise<UnitEntry> => ({
    id: unit.id,
    last: {},
    levels: unit.levels,
    num: unit.num,
    pulled: NONE,
    reqs: unit.reqs,
    root: await realPath(root),
    run: await realPath(run),
    scope: unit.scope,
    started: false,
    status: "queued",
    title: unit.title,
  }),
  createUnit = async (store: RunStore, place: UnitPlace, unit: UnitPlan): Promise<UnitEntry> => {
    const root = path.join(place.home, unit.id),
      run = path.join(root, ".denken", "runs", path.basename(store.dir));
    await addWorktree(root, place.base);
    await makeDir(path.join(run, "calls"));
    if (!(await exists(path.join(root, ".denken", ".gitignore")))) {
      await writeText(path.join(root, ".denken", ".gitignore"), "*\n");
    }
    await writeText(path.join(run, "request.md"), await unitRequest(store.dir, unit, place.units));
    await startUnitRun(store.current(), { base: place.base, run, unit });
    return entryOf(unit, root, run);
  },
  createUnits = async (store: RunStore, units: readonly UnitPlan[]): Promise<void> => {
    const { base, home } = await prepareHome(store),
      entries = await mapInOrder(units, async (unit) => {
        const entry = await createUnit(store, { base, home, units }, unit);
        return entry;
      });
    store.apply({ units: entries });
  };

export { createUnits };
