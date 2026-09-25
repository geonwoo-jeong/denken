// The merge in the record: the units' final states and patches kept beside the parent's, and the merge step.
import { copyInto, exists } from "./files.ts";
import { logDir, logStep, timeline } from "./record-log.ts";
import type { MergedUnit } from "./types-units.ts";
import type { RunStore } from "./types-store.ts";
import { eachInOrder } from "./lists.ts";
import path from "node:path";
import { verdict } from "./record-verdicts.ts";

const committedNote = (unit: MergedUnit): string => {
    if (unit.committed) {
      return " (its agent committed; the commits are included)";
    }
    return "";
  },
  mergeText = (merged: readonly MergedUnit[]): string =>
    merged.map((unit) => `## ${unit.unit}${committedNote(unit)}\n\n${unit.files.map((file) => `- ${file}`).join("\n") || "No changes."}`).join("\n\n"),
  summaryOf = (merged: readonly MergedUnit[]): string => merged.map((unit) => `${unit.unit} (${unit.files.length} file(s))`).join(", "),
  // The units' own records are already in the ai-log; each unit's final state and patch are kept beside them.
  keepUnitRecords = async (store: RunStore): Promise<void> => {
    const log = logDir(store.current());
    await eachInOrder(store.current().units, async (unit) => {
      if (await exists(path.join(unit.run, "state.json"))) {
        await copyInto(path.join(unit.run, "state.json"), path.join(log, "raw", unit.id, "state.json"));
      }
      await copyInto(path.join(store.dir, "units", `${unit.id}.patch`), path.join(log, "raw", unit.id, "merge.patch"));
    });
  },
  recordMerge = async (store: RunStore, merged: readonly MergedUnit[]): Promise<void> => {
    await keepUnitRecords(store);
    const step = await logStep(store, {
      content: `# Merge of the units\n\nEvery unit was planned, built, reviewed and verified in its own worktree. Their changes were applied together in an integration worktree, then to the project as one patch.\n\n${mergeText(merged)}\n`,
      name: "engine-merge",
      stage: "dev",
    });
    await verdict(store, { file: step, label: "Merge", text: `${summaryOf(merged)} merged into the project; UBEL now reviews the merged change, then GENAU verifies it again`, who: "ENGINE", word: "MERGED" });
    await timeline(store, "ENGINE", `merged ${summaryOf(merged)} → ${step}`);
  };

export { recordMerge };
