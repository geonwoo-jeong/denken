/*
 * The YAML frontmatter of a SKILL.md: the subset skills use (key: value, quoted values, | and >
 * blocks, and one level of nested keys). Zero dependencies. A value with YAML syntax characters must
 * be quoted, or the skills CLI skips the skill at install time.
 */
import type { Entry, Frontmatter, Step } from "./validate-types.ts";

// A key and its raw value as the key's line gives it.
interface Head {
  readonly key: string;
  readonly raw: string;
}

const FIRST_LINE = 2,
  NEXT = 1,
  START = 0,
  NOT_FOUND = -1,
  LAST = -1,
  FRONTMATTER = /^---\r?\n(?<head>[\s\S]*?)\r?\n---(?:\r?\n|$)/u,
  KEY_VALUE = /^(?<key>[A-Za-z0-9_-]+):(?:\s+(?<raw>.*))?$/u,
  NESTED = /^(?<key>[A-Za-z0-9_-]+):\s*(?<raw>.*)$/u,
  BLOCK = /^[|>][+-]?$/u,
  groupsOf = (pattern: Readonly<RegExp>, text: string): Readonly<Record<string, string>> => {
    const match = pattern.exec(text);
    if (match === null) {
      return {};
    }
    return match.groups ?? {};
  },
  jsonText = (value: string): string => {
    const text: unknown = JSON.parse(value);
    if (typeof text === "string") {
      return text;
    }
    return value;
  },
  unquote = (value: string): string => {
    if (value.startsWith('"') && value.endsWith('"')) {
      return jsonText(value);
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(NEXT, LAST).replaceAll("''", "'");
    }
    return value;
  },
  // The lines after an index that pass a test, up to the first that does not.
  runFrom = (lines: readonly string[], from: number, passes: (line: string) => boolean): readonly string[] => {
    const rest = lines.slice(from),
      end = rest.findIndex((line) => !passes(line));
    if (end === NOT_FOUND) {
      return rest;
    }
    return rest.slice(START, end);
  },
  // A | block keeps its lines apart; a > block folds them into one.
  joinerOf = (raw: string): string => {
    if (raw.startsWith("|")) {
      return "\n";
    }
    return " ";
  },
  blockEntry = (lines: readonly string[], index: number, head: Head): Entry => {
    const block = runFrom(lines, index + NEXT, (line) => /^\s/u.test(line) || !line.trim()).map((line) => line.trim());
    return { key: head.key, taken: block.length, value: block.join(joinerOf(head.raw)).trim() };
  },
  nestedEntry = (lines: readonly string[], index: number, key: string): Entry => {
    const nested = runFrom(lines, index + NEXT, (line) => /^\s/u.test(line)),
      pairs = nested.flatMap((line): (readonly [string, string])[] => {
        const groups = groupsOf(NESTED, line.trim()),
          found = groups["key"] ?? "";
        if (!found) {
          return [];
        }
        return [[found, unquote(groups["raw"] ?? "")]];
      });
    return { key, taken: nested.length, value: Object.fromEntries(pairs) };
  },
  scalarEntry = (head: Head): Entry => {
    const quoted = /^["']/u.test(head.raw);
    if (!quoted && (/:\s/u.test(head.raw) || /\s#/u.test(head.raw) || /^[[{&*!%@`]/u.test(head.raw))) {
      throw new Error(`"${head.key}" contains YAML syntax characters; wrap the value in double quotes`);
    }
    return { key: head.key, taken: START, value: unquote(head.raw) };
  },
  entryAt = (lines: readonly string[], index: number): Entry => {
    const line = lines[index] ?? "",
      groups = groupsOf(KEY_VALUE, line),
      head = { key: groups["key"] ?? "", raw: (groups["raw"] ?? "").trim() };
    if (!head.key) {
      throw new Error(`frontmatter line ${index + FIRST_LINE} is not "key: value": ${line}`);
    }
    if (BLOCK.test(head.raw)) {
      return blockEntry(lines, index, head);
    }
    if (head.raw === "") {
      return nestedEntry(lines, index, head.key);
    }
    return scalarEntry(head);
  },
  stepWith = (entry: Entry, index: number): Step => ({ entries: [entry], next: index + NEXT + entry.taken }),
  // Blank lines and comments are skipped; every other line starts a key.
  stepAt = (lines: readonly string[], index: number): Step => {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) {
      return { entries: [], next: index + NEXT };
    }
    return stepWith(entryAt(lines, index), index);
  },
  entriesOf = (lines: readonly string[]): readonly Entry[] => {
    const entries: Entry[] = [];
    let index = START;
    while (index < lines.length) {
      const step = stepAt(lines, index);
      entries.push(...step.entries);
      index = step.next;
    }
    return entries;
  },
  missing: () => never = () => {
    throw new Error("missing YAML frontmatter delimited by --- lines");
  },
  parseFrontmatter = (text: string): Frontmatter => {
    const match = FRONTMATTER.exec(text) ?? missing(),
      [whole] = match,
      lines = ((match.groups ?? {})["head"] ?? "").split(/\r?\n/u);
    return { body: text.slice(whole.length), data: Object.fromEntries(entriesOf(lines).map((entry) => [entry.key, entry.value])) };
  };

export { parseFrontmatter };
