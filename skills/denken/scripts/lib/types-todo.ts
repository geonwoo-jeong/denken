// The request (request.md) and the TODO lists as the engine reads them: sections, items and their problems.
type RequestPrefix = "CAUTION" | "LATER" | "OUT" | "REQ";

type ItemPrefix = "DEV" | "FIX" | "QA";

// A "## Heading" section of a markdown file; found is false when the heading is missing.
interface Section {
  readonly body: string;
  readonly found: boolean;
}

// An item "- REQ-001. ..." of request.md, with the text of its line and any continuation lines.
interface RequestItem {
  readonly key: string;
  readonly text: string;
}

interface RequestSection {
  readonly items: readonly RequestItem[];
  readonly present: boolean;
}

// The parsed request.md: the goal (empty when missing) and each section by its item prefix.
interface ParsedRequest {
  readonly goal: string;
  readonly sections: Readonly<Record<RequestPrefix, RequestSection>>;
}

// Where a kind of TODO item lives: its file, its section heading, and the heading's name.
interface ItemKind {
  readonly file: string;
  readonly heading: Readonly<RegExp>;
  readonly name: string;
}

/*
 * A TODO item: its checkbox, references, text, block (with continuation lines), evidence (empty
 * when none) and, for a FIX item, its QA cycle (0 elsewhere).
 */
interface TodoItem {
  readonly block: string;
  readonly cycle: number;
  readonly done: boolean;
  readonly evidence: string;
  readonly key: string;
  readonly refs: readonly string[];
  readonly text: string;
}

// A problem with the list itself; key is the item's id, or "section" when the section is missing.
interface ItemProblem {
  readonly key: string;
  readonly problem: string;
}

interface ParsedItems {
  readonly items: readonly TodoItem[];
  readonly problems: readonly ItemProblem[];
}

export type { ItemKind, ItemPrefix, ItemProblem, ParsedItems, ParsedRequest, RequestItem, RequestPrefix, RequestSection, Section, TodoItem };
