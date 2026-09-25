// A unit in the status: where it stands, the stage its run is in, and its worktree while it exists.
import { lastText, readUnit } from "./units-entries.ts";
import type { UnitEntry } from "./types-progress.ts";
import { exists } from "./files.ts";
import { textOf } from "./json.ts";

const worktreeOf = async (unit: UnitEntry): Promise<string> => {
    if (await exists(unit.root)) {
      return unit.root;
    }
    return "";
  },
  unitsStatus = async (unit: UnitEntry): Promise<Readonly<Record<string, string>>> => ({
    reason: lastText(unit, "reason"),
    stage: textOf(await readUnit(unit), "stage"),
    status: unit.status,
    unit: unit.id,
    worktree: await worktreeOf(unit),
  });

export { unitsStatus };
