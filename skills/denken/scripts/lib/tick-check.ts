/*
 * The checks a recorded tick must pass when the engine applies it. The ledger is one of STARK's own
 * call files, so every check the tick command made is made again here; an entry that fails one is
 * not applied, and goes back to STARK with the reason.
 */
import { fixItems, parseItems } from "./todo.ts";
import type { Call } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { TODO_DEV } from "./paths.ts";
import type { TickEntry } from "./types-call.ts";
import { changedSince } from "./changes.ts";
import { itemBase } from "./tick-base.ts";
import { namesFile } from "./tick-names.ts";
import { readRunFile } from "./store.ts";
import { tickPrefix } from "./ticks.ts";

const NO_CHANGE_WITH_WHY = /^No change needed: \S/u,
  PASSED = /\n\[exit 0\]\n?$/u,
  listedItems = async (store: RunStore, prefix: string): Promise<readonly string[]> => {
    if (prefix === "DEV") {
      const text = await readRunFile(store.dir, TODO_DEV);
      return parseItems(text, "DEV").items.map((item) => item.key);
    }
    if (prefix === "FIX") {
      const fixes = await fixItems(store.dir);
      return fixes.filter((fix) => fix.cycle === store.current().currentFixCycle).map((fix) => fix.key);
    }
    return [];
  },
  listProblem = async (store: RunStore, entry: TickEntry): Promise<string> => {
    const prefix = tickPrefix(entry.item),
      items = await listedItems(store, prefix);
    if (prefix === "") {
      return "it is not a DEV or FIX item";
    }
    if (items.includes(entry.item)) {
      return "";
    }
    if (prefix === "DEV") {
      return "it is not in the TODO section of todo-dev.md";
    }
    return "it is not a recovery item of the current QA cycle";
  },
  evidenceProblem = (entry: TickEntry): string => {
    if (!entry.evidence.trim()) {
      return "the record has no evidence";
    }
    if ((entry.noChange && !NO_CHANGE_WITH_WHY.test(entry.evidence)) || (!entry.noChange && entry.evidence.startsWith("No change needed:"))) {
      return "the record mixes --evidence and --no-change";
    }
    return "";
  },
  logNameProblem = (call: Call, entry: TickEntry): string => {
    if (entry.log !== `${call.id}.tick-${entry.item}.log`) {
      return "the record points to the wrong test log";
    }
    return "";
  },
  logProblem = async (store: RunStore, entry: TickEntry): Promise<string> => {
    const log = await readRunFile(store.dir, `calls/${entry.log}`);
    if (!entry.command || !log.startsWith(`$ ${entry.command}\n`) || !PASSED.test(log)) {
      return "its test log does not show the recorded command passing";
    }
    return "";
  },
  changeProblem = async (store: RunStore, entry: TickEntry): Promise<string> => {
    if (entry.noChange) {
      return "";
    }
    const base = itemBase(store.current(), entry.item),
      changed = await changedSince(store.current(), base.tree);
    if (changed.some((file) => namesFile(entry.evidence, file))) {
      return "";
    }
    return `its evidence names no file changed for it since ${base.what}`;
  },
  // Why a recorded tick is refused; empty when it is fine.
  tickProblem = async (store: RunStore, call: Call, entry: TickEntry): Promise<string> =>
    (await listProblem(store, entry)) || evidenceProblem(entry) || logNameProblem(call, entry) || (await logProblem(store, entry)) || (await changeProblem(store, entry));

export { tickProblem };
