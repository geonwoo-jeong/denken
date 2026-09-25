// Reading a scenario step's fields: numbers, lists, text, and whether a field is given at all.
import { MISSING, at, listAt } from "./test-json.ts";
import type { JsonObject } from "./test-types.ts";

const NONE = 0,
  givenAt = (step: JsonObject, key: string): boolean => at(step, key) !== MISSING,
  // A field that is set and not false, empty or 0, as JavaScript tests it.
  truthyAt = (step: JsonObject, key: string): boolean => {
    const value = at(step, key);
    return value !== MISSING && Boolean(value);
  },
  numberAt = (step: JsonObject, key: string): number => {
    const value = at(step, key);
    if (typeof value === "number") {
      return value;
    }
    return NONE;
  },
  numbersAt = (step: JsonObject, key: string): readonly number[] => listAt(step, key).filter((value): value is number => typeof value === "number"),
  stringsAt = (step: JsonObject, key: string): readonly string[] => listAt(step, key).filter((value): value is string => typeof value === "string");

export { givenAt, numberAt, numbersAt, stringsAt, truthyAt };
