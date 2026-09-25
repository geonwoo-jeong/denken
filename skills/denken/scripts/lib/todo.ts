/*
 * The TODO lists: METHODE's todo-dev.md and todo-qa.md, and the recovery todo-fix.md the engine
 * writes after a failed QA cycle. METHODE's todo-dev.md copies Confirmed (## Acceptance), Out of
 * scope and Not now (## Do not build) and Cautions (## Cautions) word for word, so STARK can work
 * from it alone, and lists "- [ ] DEV-001 (REQ-001) ..." under "## TODO". todo-qa.md lists
 * "- [ ] QA-001 (REQ-001) ..." under "## Checks". todo-fix.md lists "- [ ] FIX-001 (QA-002, REQ-002) ..."
 * under "## QA cycle <n>". A ticked item carries its evidence on the next line:
 * "  Evidence: <what was done, and where>". Only METHODE words the items; only STARK ticks DEV and
 * FIX items, through the tick command, with evidence.
 */
import { FIRST, increment } from "./lists.ts";
import type { ItemKind, ItemPrefix, ItemProblem, ParsedItems, TodoItem } from "./types-todo.ts";
import type { LineKind, ParsedLine } from "./types-parta.ts";
import { REQUEST, TODO_DEV, TODO_FIX, TODO_QA } from "./paths.ts";
import { groupOf, groupsOf, sha } from "./text.ts";
import type { Hashes } from "./types-progress.ts";
import { readRunFile } from "./store.ts";
import { sectionOf } from "./request.ts";

const NOT_FOUND = -1,
  EMPHASIS = "[*_`]*",
  HEADING = /^##\s/u,
  CONTINUATION = /^\s{2,}\S/u,
  CYCLE = /^##\s+QA cycle\s+(?<cycle>\d+)/iu,
  REFS = /\b(?:REQ|OUT|LATER|CAUTION|QA)-\d{3,}\b/gu,
  ITEM: Readonly<Record<ItemPrefix, ItemKind>> = {
    DEV: { file: TODO_DEV, heading: /^##\s+TODO\s*$/iu, name: "TODO" },
    FIX: { file: TODO_FIX, heading: /^##\s+QA cycle\b/iu, name: "QA cycle <n>" },
    QA: { file: TODO_QA, heading: /^##\s+Checks\s*$/iu, name: "Checks" },
  },
  EVIDENCE_LINE: Readonly<RegExp> = /^\s+Evidence:\s*(?<evidence>.*)$/u,
  blockedIn = (report: string, key: string): boolean => new RegExp(String.raw`\b${key}\b[^\n]*\bblocked\b`, "iu").test(report),
  // The "## " heading a line is under (the line itself, for a heading), or "" before any.
  headingAbove = (lines: readonly string[], index: number): string =>
    lines.slice(FIRST, increment(index)).findLast((line) => HEADING.test(line)) ?? "",
  inItemSection = (lines: readonly string[], index: number, heading: Readonly<RegExp>): boolean => {
    const above = headingAbove(lines, index);
    return Boolean(above) && heading.test(above.trim());
  },
  itemPattern = (prefix: ItemPrefix): RegExp =>
    new RegExp(
      String.raw`^\s*[-*]\s*\[(?<box>[ xX])\]\s*${EMPHASIS}(?<key>${prefix}-\d{3,})\b${EMPHASIS}\s*[:.]?\s*(?:\((?<refs>[^)]*)\))?(?<text>.*)$`,
      "u",
    ),
  loosePattern = (prefix: ItemPrefix): RegExp => new RegExp(String.raw`^[-*]\s*${EMPHASIS}(?<key>${prefix}-\d{3,})\b`, "u"),
  // A line inside the item section: an item, an indented line, another line, or an empty one.
  bodyKind = (line: string, prefix: ItemPrefix): LineKind => {
    if (groupOf(itemPattern(prefix), line, "key")) {
      return "item";
    }
    if (CONTINUATION.test(line)) {
      return "continuation";
    }
    if (line.trim()) {
      return "other";
    }
    return "blank";
  },
  lineKind = (lines: readonly string[], index: number, prefix: ItemPrefix): LineKind => {
    const line = lines[index] ?? "";
    if (HEADING.test(line)) {
      return "heading";
    }
    if (!inItemSection(lines, index, ITEM[prefix].heading)) {
      return "outside";
    }
    return bodyKind(line, prefix);
  },
  parseLines = (text: string, prefix: ItemPrefix): readonly ParsedLine[] => {
    const lines = text.split("\n"),
      pattern = itemPattern(prefix);
    return lines.map(
      (line, index): ParsedLine => ({
        cycle: Number(groupOf(CYCLE, headingAbove(lines, index), "cycle")),
        index,
        kind: lineKind(lines, index, prefix),
        line,
        match: groupsOf(pattern, line),
      }),
    );
  },
  keyOf = (entry: ParsedLine): string => entry.match["key"] ?? "",
  // An item line that repeats an earlier item's id: reported, and not an item of its own.
  isDuplicate = (parsed: readonly ParsedLine[], entry: ParsedLine): boolean =>
    parsed.some((other) => other.kind === "item" && other.index < entry.index && keyOf(other) === keyOf(entry)),
  endOf = (stop: number, length: number): number => {
    if (stop === NOT_FOUND) {
      return length;
    }
    return stop;
  },
  // The indented lines that belong to an item: up to the first line that is neither indented nor empty.
  ownedLines = (parsed: readonly ParsedLine[], start: number): readonly ParsedLine[] => {
    const rest = parsed.slice(increment(start)),
      stop = rest.findIndex((entry) => entry.kind !== "continuation" && entry.kind !== "blank");
    return rest.slice(FIRST, endOf(stop, rest.length)).filter((entry) => entry.kind === "continuation");
  },
  evidenceOf = (owned: readonly ParsedLine[]): string => {
    const first = owned.find((entry) => EVIDENCE_LINE.test(entry.line));
    if (!first) {
      return "";
    }
    return groupOf(EVIDENCE_LINE, first.line, "evidence").trim();
  },
  toItem = (parsed: readonly ParsedLine[], entry: ParsedLine): TodoItem => {
    const owned = ownedLines(parsed, entry.index);
    return {
      block: [entry.line, ...owned.map((line) => line.line)].join("\n"),
      cycle: entry.cycle,
      done: entry.match["box"] !== " ",
      evidence: evidenceOf(owned),
      key: keyOf(entry),
      refs: [...((entry.match["refs"] ?? "").match(REFS) ?? [])],
      text: (entry.match["text"] ?? "").trim(),
    };
  },
  lineProblems = (parsed: readonly ParsedLine[], prefix: ItemPrefix): readonly ItemProblem[] =>
    parsed.flatMap((entry): readonly ItemProblem[] => {
      const loose = groupOf(loosePattern(prefix), entry.line, "key");
      if (entry.kind === "item" && isDuplicate(parsed, entry)) {
        return [{ key: keyOf(entry), problem: `${keyOf(entry)} appears more than once` }];
      }
      if (entry.kind === "other" && loose) {
        return [{ key: loose, problem: `${loose} is not a checkbox line ("- [ ] ${loose} ...")` }];
      }
      return [];
    }),
  sectionProblems = (text: string, prefix: ItemPrefix): readonly ItemProblem[] => {
    if (text.split("\n").some((line) => ITEM[prefix].heading.test(line.trim()))) {
      return [];
    }
    return [{ key: "section", problem: `the "## ${ITEM[prefix].name}" section is missing` }];
  },
  /*
   * Items of one kind in their section: checkbox, references, text, block (with continuation lines)
   * and evidence. A line there that looks like an item but is not a checkbox line, a repeated id,
   * or a missing section is reported, never skipped: STARK reads the whole file, so an unparsed
   * item would escape the checks. Tolerates "- [ ] **DEV-001** (REQ-001) ..." and similar.
   */
  parseItems = (text: string, prefix: ItemPrefix): ParsedItems => {
    const parsed = parseLines(text, prefix);
    return {
      items: parsed.filter((entry) => entry.kind === "item" && !isDuplicate(parsed, entry)).map((entry) => toItem(parsed, entry)),
      problems: [...sectionProblems(text, prefix), ...lineProblems(parsed, prefix)],
    };
  },
  fixItems = async (runDir: string): Promise<readonly TodoItem[]> => {
    const text = await readRunFile(runDir, TODO_FIX);
    return parseItems(text, "FIX").items;
  },
  // Bullet lines under "## Open questions" in todo-dev.md, other than "None".
  openQuestions = async (runDir: string): Promise<readonly string[]> => {
    const text = await readRunFile(runDir, TODO_DEV);
    return sectionOf(text, "Open questions")
      .body.split("\n")
      .filter((line) => /^\s*[-*]\s+\S/u.test(line) && !/^\s*[-*]\s+(?:none|n\/a)\b/iu.test(line))
      .map((line) => line.replace(/^\s*[-*]\s+/u, "").trim());
  },
  // The plan as the user confirmed it: ticks and evidence lines are progress, not a change to it.
  planText = (text: string): string =>
    text
      .split("\n")
      .filter((line) => !EVIDENCE_LINE.test(line))
      .join("\n")
      .replaceAll(/^(?<bullet>\s*[-*]\s*)\[[xX]\]/gmu, "$<bullet>[ ]"),
  confirmedHashes = async (runDir: string): Promise<Hashes> => {
    const [request, todoDev, todoQa] = await Promise.all([readRunFile(runDir, REQUEST), readRunFile(runDir, TODO_DEV), readRunFile(runDir, TODO_QA)]);
    return { request: sha(request), todoDev: sha(planText(todoDev)), todoQa: sha(planText(todoQa)) };
  };

export { blockedIn, confirmedHashes, EVIDENCE_LINE, fixItems, inItemSection, ITEM, openQuestions, parseItems, planText };
