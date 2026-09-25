// Types the request, TODO, rendering and wiki modules use among themselves.
import type { Call, Finding } from "./types-items.ts";
import type { ParsedItems, ParsedRequest } from "./types-todo.ts";
import type { Stage } from "./types-names.ts";

// How the TODO parser sees a line: a heading, outside the item section, an item, or what follows one.
type LineKind = "blank" | "continuation" | "heading" | "item" | "other" | "outside";

// A line of a TODO list with its kind, its QA cycle (0 outside one) and its item groups, if any.
interface ParsedLine {
  readonly cycle: number;
  readonly index: number;
  readonly kind: LineKind;
  readonly line: string;
  readonly match: Readonly<Record<string, string>>;
}

// What the engine's check of the TODO lists reads: the request and both lists.
interface TodoInputs {
  readonly dev: ParsedItems;
  readonly devText: string;
  readonly known: readonly string[];
  readonly qa: ParsedItems;
  readonly request: ParsedRequest;
}

// What a rendered review shows on top: the verdict word ("" derives it) and a note.
interface Shown {
  readonly note: string;
  readonly word: string;
}

// A round's findings as a stage records them: the call that raised them, and its stage.
interface ReviewRecord {
  readonly call: Call;
  readonly findings: readonly Finding[];
  readonly stage: Stage;
}

export type { LineKind, ParsedLine, ReviewRecord, Shown, TodoInputs };
