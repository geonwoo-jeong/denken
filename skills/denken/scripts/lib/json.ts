// Reading and writing JSON: parsing text that may not be JSON, and taking typed values out of it.
import type { JsonObject, JsonValue, Parsed } from "./types-json.ts";
import { messageOf } from "./text.ts";

const INDENT = 2,
  EMPTY: JsonObject = {},
  // JSON.stringify takes a replacer before the indent; this one keeps every value as it is.
  keepValue = (_key: string, value: unknown): unknown => value,
  toJson = (value: unknown): string => JSON.stringify(value, keepValue, INDENT),
  toLine = (value: unknown): string => JSON.stringify(value),
  parseJson = (text: string): Parsed => {
    try {
      const value: unknown = JSON.parse(text);
      return { error: "", ok: true, value };
    } catch (error) {
      return { error: messageOf(error), ok: false, value: text };
    }
  },
  isRecord = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value),
  isList = (value: unknown): value is readonly JsonValue[] => Array.isArray(value),
  // A parsed value as a record: an empty one when it is not a JSON object.
  asRecord = (value: unknown): JsonObject => {
    if (isRecord(value)) {
      return value;
    }
    return EMPTY;
  },
  textOf = (record: JsonObject, key: string): string => {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
    return "";
  },
  numberOf = (record: JsonObject, key: string, fallback: number): number => {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
    return fallback;
  },
  flagOf = (record: JsonObject, key: string): boolean => record[key] === true,
  listOf = (record: JsonObject, key: string): readonly JsonValue[] => {
    const value = record[key];
    if (isList(value)) {
      return value;
    }
    return [];
  },
  stringsOf = (record: JsonObject, key: string): readonly string[] =>
    listOf(record, key).filter((item): item is string => typeof item === "string"),
  recordOf = (record: JsonObject, key: string): JsonObject => asRecord(record[key]),
  recordsOf = (record: JsonObject, key: string): readonly JsonObject[] => listOf(record, key).filter((item) => isRecord(item)),
  hasKey = (record: JsonObject, key: string): boolean => Object.hasOwn(record, key);

export {
  asRecord,
  EMPTY,
  flagOf,
  hasKey,
  isList,
  isRecord,
  listOf,
  numberOf,
  parseJson,
  recordOf,
  recordsOf,
  stringsOf,
  textOf,
  toJson,
  toLine,
};
