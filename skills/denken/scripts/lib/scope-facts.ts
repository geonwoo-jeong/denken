// The facts the scope report is written from: the stage's changes, the TODO items, the tick ledger and the diff.
import { DEV_REPORT, EMPTY_TREE, EXCLUDE, TODO_DEV } from "./paths.ts";
import { diffFacts, untrackedSkips } from "./scope-diff.ts";
import { fixItems, parseItems } from "./todo.ts";
import type { RunStore } from "./types-store.ts";
import type { ScopeFacts } from "./types-partc.ts";
import { gitText } from "./git.ts";
import { readRunFile } from "./store.ts";
import { stageChanges } from "./changes.ts";
import { tickLedger } from "./ticks.ts";

const gatherScope = async (store: RunStore): Promise<ScopeFacts> => {
  const state = store.current(),
    { changed, untracked } = await stageChanges(state, "dev"),
    devText = await readRunFile(store.dir, TODO_DEV),
    allFixes = await fixItems(store.dir),
    diff = diffFacts(await gitText(["diff", state.stageBase.dev || EMPTY_TREE, "--", ".", ...EXCLUDE])),
    newSkips = await untrackedSkips(untracked);
  return {
    changed,
    deletions: diff.deletions,
    fixes: allFixes.filter((fix) => fix.cycle === state.currentFixCycle),
    items: parseItems(devText, "DEV").items,
    ledger: await tickLedger(store.dir),
    report: await readRunFile(store.dir, DEV_REPORT),
    skips: [...diff.skips, ...newSkips],
  };
};

export { gatherScope };
