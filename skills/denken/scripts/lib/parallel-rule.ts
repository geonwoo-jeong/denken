// DENKEN's ruling on the whole split: a new split (while every unit waits for its first confirmation), or abort.
import { STEP, appended, increment } from "./lists.ts";
import { fail, print } from "./output.ts";
import { logStep, timeline } from "./record-log.ts";
import { now, oneLine } from "./text.ts";
import type { RunStore } from "./types-store.ts";
import { abortUnits } from "./parallel-abort.ts";
import { appendRuling } from "./record-rulings.ts";
import { assertLock } from "./lock.ts";
import { replanUnits } from "./parallel-replan.ts";
import { verdict } from "./record-verdicts.ts";

// A ruling DENKEN gave: its decision and the note that explains it.
interface Ruled {
  readonly decision: string;
  readonly note: string;
}

const NOTE_MAX = 140,
  abortRun = async (store: RunStore): Promise<void> => {
    await abortUnits(store);
    store.apply({ blocked: { info: {}, kind: "none", reason: "", since: "" }, stage: "aborted" });
  },
  recordRuling = async (store: RunStore, ruled: Ruled, reason: string): Promise<void> => {
    const state = store.current(),
      id = `R${increment(state.rulings.length)}`,
      { rulings } = store.apply({ rulings: appended(state.rulings, { at: now(), decision: ruled.decision, id, reason, stage: "units", subject: "the split" }) }),
      step = await logStep(store, { content: `# DENKEN · ruling ${id} · ${ruled.decision}\n\nOn: the split into units\n\n${ruled.note.trim()}\n`, name: `denken-ruling-${id}-${ruled.decision}`, stage: "plan" });
    await timeline(store, "DENKEN", `ruling ${id} (${ruled.decision}) on the split: ${oneLine(ruled.note, NOTE_MAX)} → ${step}`);
    await verdict(store, { file: step, label: `Ruling ${id} on the split`, text: ruled.note, who: "DENKEN", word: ruled.decision.toUpperCase() });
    await appendRuling(store.dir, `## ${id} · units · the split · ${ruled.decision}\n\n${ruled.note.trim()}\n\n`, rulings.length === STEP);
  },
  printRuled = (store: RunStore, ruled: Ruled): void => {
    const { rulings, stage, units } = store.current(),
      { id } = rulings.at(-STEP) ?? { id: "" };
    if (ruled.decision === "abort") {
      print({ action: "ruled", decision: ruled.decision, id, next: "Tell the user the run was aborted. The units' worktrees are kept for inspection.", stage, worktrees: units.map((unit) => unit.root) });
      return;
    }
    print({ action: "ruled", decision: ruled.decision, id, next: "Run next with --wait.", stage, units: units.map((unit) => unit.id) });
  },
  ruleUnits = async (store: RunStore, ruled: Ruled): Promise<void> => {
    const { blocked } = store.current(),
      reason = blocked.reason || "units";
    if (ruled.decision === "replan") {
      await replanUnits(store);
    } else if (ruled.decision === "abort") {
      await abortRun(store);
    } else {
      fail("for the whole split, the decisions are replan (a new split) or abort; to rule on one unit, add --unit <id>");
    }
    await recordRuling(store, ruled, reason);
    await assertLock();
    await store.save();
    printRuled(store, ruled);
  };

export { ruleUnits };
