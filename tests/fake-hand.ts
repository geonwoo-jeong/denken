/*
 * What STARK does to the TODO list by hand, which the engine must catch: ticking or unticking items
 * (tickByHand, untickByHand, tickOther), editing the list (editTodo), and forging tick records that
 * skip the tick command (forgeTicks).
 */
import { appendTo, readOr, writeTo } from "./fake-io.ts";
import { at, isList, isRecord, listAt, textAt } from "./test-json.ts";
import { numbersAt, truthyAt } from "./fake-values.ts";
import type { JsonObject } from "./test-types.ts";
import type { Played } from "./fake-types.ts";
import { createHash } from "node:crypto";
import { pad } from "./fake-text.ts";
import path from "node:path";

// One change to the TODO list: a checkbox set, or a text replaced.
interface HandEdit {
  readonly from: Readonly<RegExp> | string;
  readonly to: string;
}

const FORGED_LOG = "$ echo ok\n--- stdout ---\nok\n\n--- stderr ---\n\n[exit 0]\n",
  PASSED = 0,
  FROM = 0,
  TO = 1,
  boxEdit = (id: string, box: string): HandEdit => ({
    from: new RegExp(String.raw`^(?<lead>\s*[-*]\s*)\[[ xX]\](?<rest>\s*${id}\b)`, "mu"),
    to: `$<lead>[${box}]$<rest>`,
  }),
  // Text edits from the step: [[from, to], ...], each replacing the first occurrence.
  textEdits = (played: Played): readonly HandEdit[] =>
    listAt(played.step, "editTodo")
      .filter((pair) => isList(pair))
      .map((pair) => ({ from: textAt(pair, FROM), to: textAt(pair, TO) })),
  otherEdits = (played: Played): readonly HandEdit[] => {
    if (truthyAt(played.step, "tickOther")) {
      return [boxEdit(textAt(played.step, "tickOther"), "x")];
    }
    return [];
  },
  editsOf = (played: Played): readonly HandEdit[] => [
    ...numbersAt(played.step, "tickByHand").map((id) => boxEdit(`DEV-${pad(id)}`, "x")),
    ...numbersAt(played.step, "untickByHand").map((id) => boxEdit(`DEV-${pad(id)}`, " ")),
    ...otherEdits(played),
    ...textEdits(played),
  ],
  applyEdits = async (todo: string, edits: readonly HandEdit[]): Promise<void> => {
    const [edit, ...rest] = edits,
      text = await readOr(todo, "");
    if (!edit) {
      return;
    }
    await writeTo(todo, text.replace(edit.from, edit.to));
    await applyEdits(todo, rest);
  },
  handEdits = async (played: Played): Promise<void> => {
    await applyEdits(path.join(played.call.runDir, "todo-dev.md"), editsOf(played));
  },
  // A forged record: a passing-looking log, and a ledger line whose sha matches it.
  forgeOne = async (played: Played, forged: JsonObject): Promise<void> => {
    const item = textAt(forged, "item"),
      log = textAt(forged, "log") || `${played.call.callId}.tick-${item}.log`,
      logSha = createHash("sha256").update(FORGED_LOG).digest("hex");
    await writeTo(path.join(played.call.runDir, "calls", log), FORGED_LOG);
    await appendTo(
      path.join(played.call.runDir, "calls", `${played.call.callId}.ticks.jsonl`),
      `${JSON.stringify({ at: new Date().toISOString(), command: "echo ok", evidence: at(forged, "evidence"), exitCode: PASSED, item, lastLine: "ok", log, logSha, noChange: false })}\n`,
    );
  },
  forgeAll = async (played: Played, records: readonly JsonObject[]): Promise<void> => {
    const [forged, ...rest] = records;
    if (!forged) {
      return;
    }
    await forgeOne(played, forged);
    await forgeAll(played, rest);
  },
  forgeTicks = async (played: Played): Promise<void> => {
    await forgeAll(played, listAt(played.step, "forgeTicks").filter((forged) => isRecord(forged)));
  };

export { forgeTicks, handEdits };
