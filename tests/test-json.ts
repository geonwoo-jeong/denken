// Reading the engine's JSON in tests: parsing it, and taking the value at a path of keys and indexes.
import type { JsonObject, JsonValue } from "./test-types.ts";

// What a path leads to when there is nothing there, and what text that is not JSON parses to.
const MISSING = Symbol("missing"),
  isRecord = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value),
  isList = (value: unknown): value is readonly JsonValue[] => Array.isArray(value),
  // What JSON.parse returns is always JSON; this checks it, as TypeScript cannot know it.
  isJson = (value: unknown): value is JsonValue => {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return true;
    }
    if (isList(value)) {
      return value.every((item) => isJson(item));
    }
    return isRecord(value) && Object.values(value).every((item) => isJson(item));
  },
  parsed = (text: string): JsonValue | symbol => {
    try {
      const value: unknown = JSON.parse(text);
      if (isJson(value)) {
        return value;
      }
      return MISSING;
    } catch {
      return MISSING;
    }
  },
  step = (value: JsonValue | symbol, key: number | string): JsonValue | symbol => {
    if (typeof key === "number" && isList(value)) {
      return value.at(key) ?? MISSING;
    }
    if (typeof key === "string" && isRecord(value)) {
      return value[key] ?? MISSING;
    }
    return MISSING;
  },
  // The value at a path, as in at(state, "counts", "dev", "REQ-002"); MISSING when there is none.
  at = (value: JsonValue | symbol, ...path: readonly (number | string)[]): JsonValue | symbol => {
    const [first, ...rest] = path;
    if (typeof first !== "string" && typeof first !== "number") {
      return value;
    }
    return at(step(value, first), ...rest);
  },
  // The list at a path: empty when there is none.
  listAt = (value: JsonValue | symbol, ...path: readonly (number | string)[]): readonly JsonValue[] => {
    const found = at(value, ...path);
    if (isList(found)) {
      return found;
    }
    return [];
  },
  // The text at a path: empty when there is none, or it is not text.
  textAt = (value: JsonValue | symbol, ...path: readonly (number | string)[]): string => {
    const found = at(value, ...path);
    if (typeof found === "string") {
      return found;
    }
    return "";
  },
  // The keys of the record at a path: none when it is not a record.
  keysAt = (value: JsonValue | symbol, ...path: readonly (number | string)[]): readonly string[] => {
    const found = at(value, ...path);
    if (isRecord(found)) {
      return Object.keys(found);
    }
    return [];
  };

export { at, isList, isRecord, keysAt, listAt, MISSING, parsed, textAt };
