/*
 * No evidence, no tick: the item must be one STARK may tick now, and its evidence must name a file
 * changed for it since its last tick, since the engine unticked it, since its QA cycle, or since
 * development began, whichever came last.
 */
import { fixItems, parseItems } from "./todo.ts";
import type { RunStore } from "./types-store.ts";
import { TODO_DEV } from "./paths.ts";
import type { TickArgs } from "./types-tick.ts";
import { changedSince } from "./changes.ts";
import { fail } from "./output.ts";
import { hasItems } from "./lists.ts";
import { itemBase } from "./tick-base.ts";
import { namesFile } from "./tick-names.ts";
import { readRunFile } from "./store.ts";

// The files the evidence names, and the moment they are measured from.
interface Cited {
  readonly cited: readonly string[];
  readonly since: string;
}

const tickable = async (store: RunStore, item: string): Promise<boolean> => {
    if (item.startsWith("DEV-")) {
      const { items } = parseItems(await readRunFile(store.dir, TODO_DEV), "DEV");
      return items.some((todo) => todo.key === item);
    }
    const fixes = await fixItems(store.dir);
    return fixes.some((fix) => fix.key === item && fix.cycle === store.current().currentFixCycle);
  },
  checkItem = async (store: RunStore, item: string): Promise<void> => {
    if (await tickable(store, item)) {
      return;
    }
    if (item.startsWith("DEV-")) {
      fail(`${item} is not an item in the TODO section of todo-dev.md`);
    }
    fail(`${item} is not a recovery item of the current QA cycle in todo-fix.md`);
  },
  citedFiles = async (store: RunStore, args: TickArgs): Promise<Cited> => {
    const base = itemBase(store.current(), args.item),
      changed = await changedSince(store.current(), base.tree),
      cited = changed.filter((file) => Boolean(args.evidence) && namesFile(args.evidence, file));
    if (args.evidence && !hasItems(cited) && hasItems(changed)) {
      fail(`the evidence must name a file changed for ${args.item} since ${base.what}. Changed since then: ${changed.join(", ")}`);
    }
    if (args.evidence && !hasItems(cited)) {
      fail(`nothing has changed since ${base.what}. Build ${args.item} first; if it needs no change at all, tick it with --no-change "<why>" instead (UBEL reviews the reason).`);
    }
    return { cited, since: base.what };
  };

export { checkItem, citedFiles };
