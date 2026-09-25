/*
 * The parent of units steps each unit's run in the unit's worktree (next --wait 0), and brings
 * DENKEN whatever a unit needs. Stepping one unit, pulling its verdicts, and what DENKEN is shown.
 */
import { lastText, readUnit, withUnit } from "./units-entries.ts";
import type { JsonObject } from "./types-json.ts";
import { ROOT } from "./paths.ts";
import type { RunStore } from "./types-store.ts";
import type { UnitEntry } from "./types-progress.ts";
import { mapInOrder } from "./lists.ts";
import path from "node:path";
import { stringsOf } from "./json.ts";
import { writeVerdicts } from "./record-verdicts.ts";

const VERDICT_TIME = /^- (?<time>\d{2}:\d{2}:\d{2}) · /u,
  pullLines = async (store: RunStore, lines: readonly string[]): Promise<void> => {
    const [first, ...rest] = lines;
    if (typeof first !== "string") {
      return;
    }
    await writeVerdicts(store, first);
    await pullLines(store, rest);
  },
  // A unit's verdict lines, pulled into the parent's verdicts.md with the unit's name after the time.
  pullUnit = async (store: RunStore, unit: UnitEntry): Promise<void> => {
    const lines = stringsOf(await readUnit(unit), "verdicts"),
      fresh = lines.slice(unit.pulled).map((line) => line.replace(VERDICT_TIME, `- $<time> · ${unit.id} · `));
    await pullLines(store, fresh);
    store.apply({ units: withUnit(store.current().units, unit.id, { pulled: Math.max(unit.pulled, lines.length) }) });
  },
  pullVerdicts = async (store: RunStore): Promise<void> => {
    await mapInOrder(store.current().units, async (unit) => {
      await pullUnit(store, unit);
      return unit;
    });
  },
  unitAction = (runDir: string, unit: UnitEntry): JsonObject => {
    const run = path.relative(ROOT, runDir);
    return Object.assign(structuredClone(unit.last), {
      next: `${lastText(unit, "next")} This is ${unit.id}'s: run the command on this run with --unit ${unit.id} (for example: rule ${run} --unit ${unit.id} --decision ...). The other units keep working; run next again to move them on.`.trim(),
      run,
      unit: unit.id,
      unitTitle: unit.title,
    });
  },
  unitsSummary = (units: readonly UnitEntry[]): readonly JsonObject[] =>
    units.map((unit) => {
      const fields: readonly (readonly [string, string])[] = [
        ["unit", unit.id],
        ["status", unit.status],
        ["reason", lastText(unit, "reason")],
        ["call", lastText(unit, "call")],
      ];
      return Object.fromEntries(fields.filter(([, value]) => value));
    });

export { pullVerdicts, unitAction, unitsSummary };
