/*
 * The request (request.md), DENKEN's summary of the conversation with the user: its sections and
 * items, and the checks on it.
 *   ## Goal          the user's goal
 *   ## Confirmed     "- REQ-001. ... Done when: ..."   what will be built
 *   ## Out of scope  "- OUT-001. ..."                  what is not part of this work
 *   ## Not now       "- LATER-001. ..."                what is deferred to later
 *   ## Cautions      "- CAUTION-001. ..."              what to be careful about
 */
import { FIRST, hasItems, increment, isEmpty, onlyIf } from "./lists.ts";
import type { ParsedRequest, RequestItem, RequestPrefix, RequestSection, Section } from "./types-todo.ts";
import { allGroups, groupOf } from "./text.ts";
import { REQUEST } from "./paths.ts";
import type { RunStore } from "./types-store.ts";
import { readRunFile } from "./store.ts";

interface Found {
  readonly index: number;
  readonly key: string;
}

const NOT_FOUND = -1,
  EMPHASIS = "[*_`]*",
  HEADING = /^##\s/u,
  BULLET = /^\s*[-*]\s/u,
  BULLET_WIDTH = 2,
  UNCLEAR = /\[NEEDS CLARIFICATION:(?<question>[^\]]*)\]/giu,
  REQUEST_SECTIONS: Readonly<Record<RequestPrefix, string>> = { CAUTION: "Cautions", LATER: "Not now", OUT: "Out of scope", REQ: "Confirmed" },
  REQUEST_PREFIXES: readonly RequestPrefix[] = ["REQ", "OUT", "LATER", "CAUTION"],
  BOUNDS: readonly RequestPrefix[] = ["OUT", "LATER", "CAUTION"],
  sectionEnd = (lines: readonly string[], start: number): number => {
    const end = lines.findIndex((line, index) => index > start && HEADING.test(line));
    if (end === NOT_FOUND) {
      return lines.length;
    }
    return end;
  },
  // A "## Heading" section's body, up to the next "## " heading.
  sectionOf = (text: string, heading: string): Section => {
    const lines = text.split("\n"),
      pattern = new RegExp(String.raw`^##\s+${heading}\s*$`, "iu"),
      start = lines.findIndex((line) => pattern.test(line.trim()));
    if (start === NOT_FOUND) {
      return { body: "", found: false };
    }
    return { body: lines.slice(increment(start), sectionEnd(lines, start)).join("\n"), found: true };
  },
  // A continuation line: not empty, and not a bullet of its own.
  continues = (line: string): boolean => Boolean(line.trim()) && !BULLET.test(line.slice(FIRST, BULLET_WIDTH)),
  // Items "- REQ-001. ..." in a section, each with the text of its line and any continuation lines.
  sectionItems = (body: string, prefix: string): readonly RequestItem[] => {
    const lines = body.split("\n"),
      pattern = new RegExp(String.raw`^\s*[-*]\s*${EMPHASIS}(?<key>${prefix}-\d{3,})\b`, "u"),
      found = lines.map((line, index): Found => ({ index, key: groupOf(pattern, line, "key") })).filter((entry) => entry.key);
    return found.map((entry, position) => {
      const end = (found[increment(position)] ?? { index: lines.length }).index,
        more = lines.slice(increment(entry.index), end).filter((line) => continues(line));
      return { key: entry.key, text: [lines[entry.index] ?? "", ...more].join("\n") };
    });
  },
  sectionFor = (text: string, prefix: RequestPrefix): RequestSection => {
    const found = sectionOf(text, REQUEST_SECTIONS[prefix]);
    return { items: sectionItems(found.body, prefix), present: found.found };
  },
  parseRequest = (text: string): ParsedRequest => ({
    goal: sectionOf(text, "Goal").body,
    sections: {
      CAUTION: sectionFor(text, "CAUTION"),
      LATER: sectionFor(text, "LATER"),
      OUT: sectionFor(text, "OUT"),
      REQ: sectionFor(text, "REQ"),
    },
  }),
  requestProblems = (text: string): readonly string[] => {
    const parsed = parseRequest(text),
      req = parsed.sections.REQ,
      unclear = allGroups(UNCLEAR, text, "question").map((question) => question.trim());
    return [
      ...onlyIf(!parsed.goal.trim(), ['request.md needs a "## Goal" section with the user\'s goal']),
      ...onlyIf(!req.present || isEmpty(req.items), ['request.md needs a "## Confirmed" section with items "- REQ-001. ... Done when: ..."']),
      ...req.items.filter((item) => !/done when/iu.test(item.text)).map((item) => `${item.key} needs a "Done when:" condition someone could check`),
      ...BOUNDS.filter((prefix) => !parsed.sections[prefix].present).map(
        (prefix) => `request.md needs a "## ${REQUEST_SECTIONS[prefix]}" section (items "- ${prefix}-001. ...", or "- None")`,
      ),
      ...onlyIf(hasItems(unclear), [`request.md still has open questions for the user: ${unclear.join("; ")}`]),
    ];
  },
  // An item's text as a contract: only whitespace, the bullet, emphasis and case may differ.
  contract = (text: string): string =>
    text
      .replace(/^\s*[-*]\s*/u, "")
      .replaceAll(/[*_`]/gu, "")
      .replaceAll(/\s+/gu, " ")
      .trim()
      .toLowerCase(),
  requestItems = async (runDir: string): Promise<readonly RequestItem[]> => {
    const parsed = parseRequest(await readRunFile(runDir, REQUEST));
    return REQUEST_PREFIXES.flatMap((prefix) => parsed.sections[prefix].items);
  },
  /*
   * Ids are never reused. Once the user has confirmed an item, its id keeps that wording; a changed
   * item gets a new id, so findings, rulings and TODO references keep meaning what they meant.
   */
  reusedIds = async (store: RunStore): Promise<readonly string[]> => {
    const confirmed = store.current().requestIds,
      items = await requestItems(store.dir);
    return items
      .filter((item) => Object.hasOwn(confirmed, item.key) && confirmed[item.key] !== contract(item.text))
      .map(
        (item) =>
          `${item.key} now reads differently from what the user confirmed. Ids are never reused: restore ${item.key}, or remove it and add the new wording under a number not used before`,
      );
  };

export { contract, parseRequest, REQUEST_PREFIXES, REQUEST_SECTIONS, requestItems, requestProblems, reusedIds, sectionItems, sectionOf };
