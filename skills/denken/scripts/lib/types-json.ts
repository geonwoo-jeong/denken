// JSON as the engine reads and writes it: state, jobs, results and the actions it prints.
type JsonValue = boolean | JsonObject | number | string | null | readonly JsonValue[];

interface JsonObject {
  readonly [key: string]: JsonValue;
}

// Parsing text that may not be JSON: the value, or why it could not be read.
interface Parsed {
  readonly error: string;
  readonly ok: boolean;
  readonly value: unknown;
}

export type { JsonObject, JsonValue, Parsed };
