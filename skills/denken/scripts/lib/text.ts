// Text helpers: times, padding, one-line summaries, slugs, hashes and regular-expression escapes.
import { createHash } from "node:crypto";

const START = 0,
  CLOCK_LENGTH = 8,
  LINE_MAX = 200,
  SLUG_MAX = 60,
  STAMP_LENGTH = 14,
  now = (): string => new Date().toISOString(),
  clock = (): string => new Date().toTimeString().slice(START, CLOCK_LENGTH),
  pad = (value: number, width: number): string => String(value).padStart(width, "0"),
  // Text on one line: runs of whitespace become one space, and it is cut at max characters.
  oneLine = (text: string, max = LINE_MAX): string => text.replaceAll(/\s+/gu, " ").trim().slice(START, max),
  slug = (text: string): string =>
    text
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(START, SLUG_MAX) || "item",
  sha = (text: string): string => createHash("sha256").update(text).digest("hex"),
  // For "binary" text: bytes read as latin1, one character per byte.
  shaBinary = (text: string): string => createHash("sha256").update(text, "latin1").digest("hex"),
  escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`),
  messageOf = (error: unknown): string => {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  },
  // The named groups of a pattern's first match in a text; none when it does not match.
  groupsOf = (pattern: Readonly<RegExp>, text: string): Readonly<Record<string, string>> => {
    const match = pattern.exec(text);
    if (match === null) {
      return {};
    }
    return match.groups ?? {};
  },
  groupOf = (pattern: Readonly<RegExp>, text: string, name: string): string => groupsOf(pattern, text)[name] ?? "",
  // One named group of every match of a global pattern, in order.
  allGroups = (pattern: Readonly<RegExp>, text: string, name: string): readonly string[] => {
    const found: string[] = [];
    for (const match of text.matchAll(pattern)) {
      const groups = match.groups ?? {};
      found.push(groups[name] ?? "");
    }
    return found;
  },
  // An optional segment of a sentence: the text between its surroundings, or nothing when it is empty.
  framed = (before: string, text: string, after: string): string => {
    if (text) {
      return `${before}${text}${after}`;
    }
    return "";
  },
  // The time as digits only (YYYYMMDDhhmmss), for file names.
  stamp = (): string => now().replaceAll(/\D/gu, "").slice(START, STAMP_LENGTH),
  codeOf = (error: unknown): string => {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    return "";
  };

export { allGroups, clock, codeOf, escapeRegExp, framed, groupOf, groupsOf, LINE_MAX, messageOf, now, oneLine, pad, sha, shaBinary, slug, stamp, START };
