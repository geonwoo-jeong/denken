/*
 * Ticking items off, with evidence. STARK ticks a DEV or FIX item off only through `denken.ts tick`,
 * which checks the evidence, runs the item's test command and, only when it passes, records the tick
 * in a ledger (calls/<call>.ticks.jsonl, output in calls/<call>.tick-<item>.log). When the call ends,
 * the engine writes each recorded tick and its evidence into the TODO file. The engine is the only
 * writer of ticks and evidence, so STARK may not change the TODO files at all. Unticking is the
 * engine's too. This module keeps the ledger and writes the ticks.
 */
import { EVIDENCE_LINE, ITEM, inItemSection } from "./todo.ts";
import { NONE, STEP, increment, mapAsync, withEntry } from "./lists.ts";
import { START, groupOf } from "./text.ts";
import { asRecord, flagOf, isRecord, numberOf, parseJson, stringsOf, textOf } from "./json.ts";
import { hashFile, listNames, readTextOr, writeText } from "./files.ts";
import type { ItemPrefix } from "./types-todo.ts";
import type { TextMap } from "./types-names.ts";
import type { TickChange } from "./types-partc.ts";
import type { TickEntry } from "./types-call.ts";
import path from "node:path";

const NOT_FOUND = -1,
  SHA256 = /^[\da-f]{64}$/u,
  SUCCESS = 0,
  UNKNOWN_EXIT = -1,
  EVIDENCE_MAX = 400,
  EVIDENCE_CUT = 360,
  CONTINUATION = /^\s{2,}\S/u,
  CHECKBOX = /\[[ xX]\]/u,
  LEDGER_FILE = /^dev-stark-\d+\.ticks\.jsonl$/u,
  TICK_ITEM = /^(?<prefix>DEV|FIX)-\d{3,}$/u,
  // Evidence as it is written under an item: one line, at most 400 characters. The full text stays in the tick record and step file.
  evidenceLine = (evidence: string): string => {
    const flat = evidence.replaceAll(/\s+/gu, " ").trim();
    if (flat.length <= EVIDENCE_MAX) {
      return flat;
    }
    return `${flat.slice(START, EVIDENCE_CUT)} … (truncated; full text in the tick record)`;
  },
  // DEV or FIX for a tickable item's id; empty for anything else.
  tickPrefix = (item: string): ItemPrefix | "" => {
    const prefix = groupOf(TICK_ITEM, item, "prefix");
    if (prefix === "DEV" || prefix === "FIX") {
      return prefix;
    }
    return "";
  },
  // A record whose noChange is not a flag has no usable evidence: the tick is refused for that.
  evidenceOf = (record: Readonly<Record<string, unknown>>): string => {
    if (typeof record["noChange"] === "boolean" && typeof record["evidence"] === "string") {
      return record["evidence"];
    }
    return "";
  },
  toTickEntry = (value: unknown): TickEntry => {
    const record = asRecord(value);
    return {
      at: textOf(record, "at"),
      cited: stringsOf(record, "cited"),
      command: textOf(record, "command"),
      evidence: evidenceOf(record),
      exitCode: numberOf(record, "exitCode", UNKNOWN_EXIT),
      item: textOf(record, "item"),
      lastLine: textOf(record, "lastLine"),
      log: textOf(record, "log"),
      logSha: textOf(record, "logSha"),
      noChange: flagOf(record, "noChange"),
      since: textOf(record, "since"),
    };
  },
  // The records in a ledger's text that name an item, in order.
  ledgerRecords = (text: string): readonly TickEntry[] =>
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => parseJson(line))
      .filter((parsed) => parsed.ok && isRecord(parsed.value) && typeof parsed.value["item"] === "string")
      .map((parsed) => toTickEntry(parsed.value)),
  latestOf = (entries: readonly TickEntry[], newer: (entry: TickEntry, known: TickEntry) => boolean): TextMap<TickEntry> => {
    let latest: TextMap<TickEntry> = {};
    for (const entry of entries) {
      const known = latest[entry.item];
      if (!known || newer(entry, known)) {
        latest = withEntry(latest, entry.item, entry);
      }
    }
    return latest;
  },
  // One call's ticks, the last record per item, in the order the items were first ticked.
  callTicks = (text: string): readonly TickEntry[] => Object.values(latestOf(ledgerRecords(text), () => true)),
  // A record whose log still has the sha it recorded: a real sha, never a mark such as "missing".
  intact = async (runDir: string, entries: readonly TickEntry[]): Promise<readonly TickEntry[]> => {
    const checks = await mapAsync(entries, async (entry) => {
      const hash = await hashFile(path.join(runDir, "calls", entry.log));
      return SHA256.test(entry.logSha) && hash === entry.logSha;
    });
    return entries.filter((_entry, index) => checks[index] === true);
  },
  // Ledger entries whose output log is intact, by item, the latest winning.
  tickLedger = async (runDir: string): Promise<TextMap<TickEntry>> => {
    const names = await listNames(path.join(runDir, "calls")),
      texts = await mapAsync(
        names.filter((name) => LEDGER_FILE.test(name)),
        async (name) => {
          const text = await readTextOr(path.join(runDir, "calls", name), "");
          return text;
        },
      ),
      passed = texts.flatMap((text) => ledgerRecords(text)).filter((entry) => entry.exitCode === SUCCESS),
      entries = await intact(runDir, passed);
    return latestOf(entries, (entry, known) => entry.at > known.at);
  },
  boxOf = (ticked: boolean): string => {
    if (ticked) {
      return "[x]";
    }
    return "[ ]";
  },
  itemLine = (prefix: ItemPrefix): Readonly<RegExp> => new RegExp(String.raw`^\s*[-*]\s*\[[ xX]\]\s*[*_\u0060]*(?<key>${prefix}-\d{3,})\b`, "u"),
  itemIndex = (lines: readonly string[], tick: TickChange): number =>
    lines.findIndex((line, index) => groupOf(itemLine(tick.prefix), line, "key") === tick.key && inItemSection(lines, index, ITEM[tick.prefix].heading)),
  // Where an item's evidence line is, or would go: after its continuation lines.
  evidenceAt = (lines: readonly string[], start: number): number => {
    const offset = lines.slice(start).findIndex((line) => !CONTINUATION.test(line) || EVIDENCE_LINE.test(line));
    if (offset === NOT_FOUND) {
      return lines.length;
    }
    return start + offset;
  },
  retick = (lines: readonly string[], index: number, tick: TickChange): readonly string[] => {
    const boxed = lines.with(index, (lines[index] ?? "").replace(CHECKBOX, boxOf(tick.ticked))),
      at = evidenceAt(boxed, increment(index)),
      has = EVIDENCE_LINE.test(boxed[at] ?? "");
    if (tick.ticked && tick.evidence) {
      if (has) {
        return boxed.with(at, `  Evidence: ${evidenceLine(tick.evidence)}`);
      }
      return boxed.toSpliced(increment(index), NONE, `  Evidence: ${evidenceLine(tick.evidence)}`);
    }
    if (!tick.ticked && has) {
      return boxed.toSpliced(at, STEP);
    }
    return boxed;
  },
  // Ticks (or unticks) an item in its TODO file; false when the item is not there.
  setTick = async (runDir: string, tick: TickChange): Promise<boolean> => {
    const file = path.join(runDir, ITEM[tick.prefix].file),
      text = await readTextOr(file, ""),
      lines = text.split("\n"),
      index = itemIndex(lines, tick);
    if (index === NOT_FOUND) {
      return false;
    }
    await writeText(file, retick(lines, index, tick).join("\n"));
    return true;
  };

export { callTicks, evidenceLine, setTick, tickLedger, tickPrefix, toTickEntry };
