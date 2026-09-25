/*
 * Facts about a change's scope and tests, for UBEL: each item's status, evidence and test run, the
 * change's scope against the files the DEV items name, and signs of weakened tests.
 */
import { EVIDENCE_LINE, blockedIn } from "./todo.ts";
import { entriesOf, hasItems } from "./lists.ts";
import type { RunStore } from "./types-store.ts";
import type { ScopeFacts } from "./types-partc.ts";
import { TEST_FILE } from "./scope-diff.ts";
import type { TextMap } from "./types-names.ts";
import type { TodoItem } from "./types-todo.ts";
import { framed } from "./text.ts";
import { gatherScope } from "./scope-facts.ts";

type Named = TextMap<readonly string[]>;

const QUOTED = /`(?<quoted>[^`]+)`/gu,
  WITH_EXTENSION = /\.\w+$/u,
  PATH_CHARS = /^[\w./-]+$/u,
  TRAILING_SLASH = /\/$/u,
  pathLike = (text: string): boolean => PATH_CHARS.test(text) && (text.includes("/") || WITH_EXTENSION.test(text)),
  // A name without an extension is taken as a directory, and covers everything under it.
  covers = (name: string, file: string): boolean => file === name || (!WITH_EXTENSION.test(name) && file.startsWith(`${name.replace(TRAILING_SLASH, "")}/`)),
  quotedIn = (text: string): readonly string[] => {
    const found: string[] = [];
    for (const match of text.matchAll(QUOTED)) {
      found.push((match.groups ?? {})["quoted"] ?? "");
    }
    return found;
  },
  // The paths a DEV item names in backticks, from its plan (not its evidence).
  namedBy = (item: TodoItem): readonly string[] =>
    quotedIn(
      item.block
        .split("\n")
        .filter((line) => !EVIDENCE_LINE.test(line))
        .join("\n"),
    ).filter((text) => pathLike(text)),
  listed = (values: readonly string[]): string => {
    if (hasItems(values)) {
      return values.join(", ");
    }
    return "none";
  },
  boxOf = (item: TodoItem): string => {
    if (item.done) {
      return "[x]";
    }
    return "[ ]";
  },
  runOf = (facts: ScopeFacts, key: string): string => {
    const entry = facts.ledger[key];
    if (!entry) {
      return "";
    }
    return `, test \`${entry.command}\` exit 0 (${entry.lastLine || "no output"})`;
  },
  blockedMark = (facts: ScopeFacts, item: TodoItem): string => {
    if (!item.done && blockedIn(facts.report, item.key)) {
      return " reported blocked";
    }
    return "";
  },
  statusOf = (facts: ScopeFacts, item: TodoItem): string =>
    `${item.key} ${boxOf(item)}${blockedMark(facts, item)}${framed(', evidence: "', item.evidence, '"')}${runOf(facts, item.key)}`,
  touched = (names: readonly string[], changed: readonly string[]): boolean => names.some((name) => changed.some((file) => covers(name, file))),
  testedIn = (names: readonly string[], changed: readonly string[]): boolean =>
    names.some((name) => TEST_FILE.test(name) && changed.some((file) => covers(name, file))),
  namesOf = (named: Named, item: TodoItem): readonly string[] => named[item.key] ?? [],
  noChangeOf = (facts: ScopeFacts): readonly string[] =>
    [...facts.items, ...facts.fixes].flatMap((item) => {
      const entry = facts.ledger[item.key];
      if (item.done && entry && entry.noChange) {
        return [`${item.key} (${entry.evidence})`];
      }
      return [];
    }),
  reportOf = (facts: ScopeFacts, named: Named): readonly string[] => {
    const allNamed = Object.values(named).flat(),
      ticked = facts.items.filter((item) => item.done);
    return [
      `Items, evidence and recorded test runs: ${listed([...facts.items, ...facts.fixes].map((item) => statusOf(facts, item)))}`,
      `Files changed in this stage: ${listed(facts.changed)}`,
      `Changed files that no DEV item names: ${listed(facts.changed.filter((file) => !allNamed.some((name) => covers(name, file))))}. Judge whether each belongs to the plan.`,
      `Ticked DEV items none of whose named files changed: ${listed(ticked.filter((item) => hasItems(namesOf(named, item)) && !touched(namesOf(named, item), facts.changed)).map((item) => `${item.key} (${namesOf(named, item).join(", ")})`))}. Check that they were really done.`,
      `Ticked DEV items that name no files: ${listed(ticked.filter((item) => !hasItems(namesOf(named, item))).map((item) => item.key))}.`,
      `Ticked DEV items with no named test file added or changed: ${listed(ticked.filter((item) => !testedIn(namesOf(named, item), facts.changed)).map((item) => item.key))}.`,
      `Items ticked as needing no change: ${listed(noChangeOf(facts))}. Judge whether each reason holds.`,
      `Lines deleted from test files: ${listed(entriesOf(facts.deletions).map(([file, count]) => `${file} (${count})`))}. Check that no test was weakened.`,
      `Skip markers added: ${listed(facts.skips)}.`,
    ];
  },
  scopeReport = async (store: RunStore): Promise<string> => {
    const facts = await gatherScope(store),
      named: Named = Object.fromEntries(facts.items.map((item) => [item.key, namedBy(item)] as const));
    return reportOf(facts, named).join("\n  ");
  };

export { scopeReport };
