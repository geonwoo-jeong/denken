/*
 * Applying the ticks one STARK call recorded: the latest record per item, applied to the TODO files
 * when the call ends. Each applied tick's base (when, and the changed files' state) is kept in
 * state.json, the only place itemBase reads it from.
 */
import type { AppliedTicks, TickRejection } from "./types-work.ts";
import { callTicks, setTick, tickPrefix } from "./ticks.ts";
import { mapAsync, withEntry } from "./lists.ts";
import type { Call } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import type { TickEntry } from "./types-call.ts";
import { changeTree } from "./changes.ts";
import { now } from "./text.ts";
import { readRunFile } from "./store.ts";
import { tickProblem } from "./tick-check.ts";

const tickOne = async (runDir: string, entry: TickEntry): Promise<void> => {
    const prefix = tickPrefix(entry.item);
    if (prefix !== "") {
      await setTick(runDir, { evidence: entry.evidence, key: entry.item, prefix, ticked: true });
    }
  },
  // One after another: every tick rewrites a TODO file.
  tickAll = async (runDir: string, entries: readonly TickEntry[]): Promise<void> => {
    const [first, ...rest] = entries;
    if (first) {
      await tickOne(runDir, first);
      await tickAll(runDir, rest);
    }
  },
  // Bases are taken after every tick of the call is applied, from the files as the call left them.
  recordBases = async (store: RunStore, call: Call, applied: readonly TickEntry[]): Promise<void> => {
    const tree = await changeTree(store.current()),
      at = now();
    let bases = store.current().tickBases;
    for (const entry of applied) {
      bases = withEntry(bases, entry.item, { at, call: call.id, tree });
    }
    store.apply({ tickBases: bases });
  },
  rejectionOf = (entry: TickEntry, problem: string): readonly TickRejection[] => {
    if (problem) {
      return [{ item: entry.item, problem }];
    }
    return [];
  },
  applyTicks = async (store: RunStore, call: Call): Promise<AppliedTicks> => {
    const entries = callTicks(await readRunFile(store.dir, `calls/${call.id}.ticks.jsonl`)),
      problems = await mapAsync(entries, async (entry) => {
        const problem = await tickProblem(store, call, entry);
        return problem;
      }),
      applied = entries.filter((_entry, index) => (problems[index] ?? "") === ""),
      rejected = entries.flatMap((entry, index) => rejectionOf(entry, problems[index] ?? ""));
    await tickAll(store.dir, applied);
    await recordBases(store, call, applied);
    return { applied, rejected };
  };

export { applyTicks };
