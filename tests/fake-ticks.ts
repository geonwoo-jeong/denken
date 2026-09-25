/*
 * STARK's ticks: DEV items ticked off through the engine's tick command, as STARK does once an item's
 * tests pass (tick, tickFail, evidence, noChange, tickArgs), then the recovery items of the latest QA
 * cycle (fixTick, fixEvidence); after that, what the step does by hand to the TODO list.
 */
import { allGroups, groupOf, pad } from "./fake-text.ts";
import { at, textAt } from "./test-json.ts";
import { forgeTicks, handEdits } from "./fake-hand.ts";
import { givenAt, numbersAt, stringsAt } from "./fake-values.ts";
import { readOr, runNode } from "./fake-io.ts";
import type { Played } from "./fake-types.ts";
import path from "node:path";

// The engine's tick command, as the prompt names it, and the call it ticks for.
interface Ticking {
  readonly played: Played;
  readonly script: string;
}

const LAST = -1,
  DEV_LINE = /^\s*[-*]\s*\[[ xX]\]\s*DEV-(?<num>\d{3,})\b/gmu,
  OPEN_FIX = /^\s*[-*]\s*\[ \]\s*(?<key>FIX-\d{3,})\b/gmu,
  textOr = (played: Played, key: string, fallback: string): string => {
    if (givenAt(played.step, key)) {
      return textAt(played.step, key);
    }
    return fallback;
  },
  reasonOf = (ticking: Ticking, id: number): readonly string[] => {
    const { played } = ticking,
      noChange = textAt(played.step, "noChange", String(id));
    if (noChange) {
      return ["--no-change", noChange];
    }
    return ["--evidence", textOr(played, "evidence", `changed ${played.call.devFile}`)];
  },
  commandOf = (ticking: Ticking, id: number): readonly string[] => {
    if (numbersAt(ticking.played.step, "tickFail").includes(id)) {
      return ["false"];
    }
    if (givenAt(ticking.played.step, "tickArgs")) {
      return stringsAt(ticking.played.step, "tickArgs");
    }
    return ["echo", "ok"];
  },
  tickDevs = async (ticking: Ticking, ids: readonly number[]): Promise<void> => {
    const [id, ...rest] = ids;
    if (typeof id !== "number") {
      return;
    }
    await runNode([ticking.script, "tick", ticking.played.call.runDir, `DEV-${pad(id)}`, ...reasonOf(ticking, id), "--", ...commandOf(ticking, id)]);
    await tickDevs(ticking, rest);
  },
  tickFixes = async (ticking: Ticking, keys: readonly string[]): Promise<void> => {
    const [key, ...rest] = keys,
      { played } = ticking;
    if (typeof key !== "string") {
      return;
    }
    await runNode([ticking.script, "tick", played.call.runDir, key, "--evidence", textOr(played, "fixEvidence", `fixed the cause in ${played.call.devFile}`), "--", "echo", "fixed"]);
    await tickFixes(ticking, rest);
  },
  // The recovery items still open in the latest QA cycle, unless the step leaves them (fixTick false).
  openFixes = async (played: Played): Promise<readonly string[]> => {
    const text = await readOr(path.join(played.call.runDir, "todo-fix.md"), "");
    if (at(played.step, "fixTick") === false) {
      return [];
    }
    return allGroups(OPEN_FIX, text.split(/^## QA cycle \d+/mu).at(LAST) ?? "", "key");
  },
  // The DEV items to tick: the step's tick list (all when it gives none), less those ticked by hand.
  devIds = async (played: Played): Promise<readonly number[]> => {
    const todo = await readOr(path.join(played.call.runDir, "todo-dev.md"), ""),
      ids = allGroups(DEV_LINE, todo, "num").map(Number),
      chosen = numbersAt(played.step, "tick"),
      byHand = numbersAt(played.step, "tickByHand");
    return ids.filter((id) => (!givenAt(played.step, "tick") || chosen.includes(id)) && !byHand.includes(id));
  },
  tickItems = async (played: Played): Promise<void> => {
    const ticking = { played, script: groupOf(/node "(?<script>[^"]+)" tick "/u, played.call.prompt, "script") };
    await tickDevs(ticking, await devIds(played));
    await tickFixes(ticking, await openFixes(played));
    await handEdits(played);
    await forgeTicks(played);
  };

export { tickItems };
