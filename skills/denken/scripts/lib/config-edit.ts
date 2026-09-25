// Changing a config file's values by dotted key: which keys exist, and setting or removing one.
import type { JsonObject, JsonValue } from "./types-json.ts";
import { asRecord, hasKey, isRecord, recordOf } from "./json.ts";
import { entriesOf, hasItems, isEmpty, lastOf } from "./lists.ts";
import { LIMIT_KEYS } from "./config-merge.ts";
import { fail } from "./output.ts";
import { isProvider } from "./config-defaults.ts";

const ROLES: readonly string[] = ["methode", "stark", "serie", "richter", "ubel", "frieren", "genau"],
  ROLE_FIELDS: ReadonlySet<string> = new Set(["provider", "model", "effort", "network"]),
  LEVEL_NAMES: ReadonlySet<string> = new Set(["light", "heavy"]),
  LEVEL_FIELDS: ReadonlySet<string> = new Set(["model", "effort"]),
  ONE_PART = 1,
  TWO_PARTS = 2,
  FOUR_PARTS = 4,
  KEY_HELP = `Keys: <role>[.model|.effort|.network] (roles: ${ROLES.join(", ")}), providers, allowSameReviewer, limits.topicRepeats, limits.roundsPerStage, limits.callTimeoutMin, limits.parallelUnits, levels.<claude|codex>.<light|heavy>.<model|effort>, seeds.<claude|codex>`,
  levelPath = (parts: readonly string[]): readonly string[] => {
    const [, provider = "", level = "", field = ""] = parts;
    if (parts.length === FOUR_PARTS && isProvider(provider) && LEVEL_NAMES.has(level) && LEVEL_FIELDS.has(field)) {
      return ["levels", provider, level, field];
    }
    return [];
  },
  settingPath = (parts: readonly string[]): readonly string[] => {
    const [head = "", second = ""] = parts;
    if ((head === "providers" || head === "allowSameReviewer") && parts.length === ONE_PART) {
      return [head];
    }
    if (head === "seeds" && parts.length === TWO_PARTS && isProvider(second)) {
      return ["seeds", second];
    }
    if (head === "levels") {
      return levelPath(parts);
    }
    if (head === "limits" && parts.length === TWO_PARTS && LIMIT_KEYS.some((key) => key === second)) {
      return ["limits", second];
    }
    return [];
  },
  rolePath = (parts: readonly string[]): readonly string[] => {
    const [role = "", field = ""] = parts;
    if (!ROLES.includes(role)) {
      return [];
    }
    if (parts.length === ONE_PART) {
      return ["roles", role, "provider"];
    }
    if (parts.length === TWO_PARTS && ROLE_FIELDS.has(field)) {
      return ["roles", role, field];
    }
    return [];
  },
  // Where a dotted key lives in a config file; none for a key that does not exist.
  keyPath = (key: string): readonly string[] => {
    const parts = key.split("."),
      setting = settingPath(parts);
    if (hasItems(setting)) {
      return setting;
    }
    return rolePath(parts);
  },
  withPath = (record: JsonObject, keys: readonly string[], value: JsonValue): JsonObject => {
    const [key = "", ...rest] = keys;
    if (isEmpty(rest)) {
      return Object.fromEntries([...entriesOf(record), [key, value]]);
    }
    return Object.fromEntries([...entriesOf(record), [key, withPath(asRecord(record[key]), rest, value)]]);
  },
  withoutPath = (record: JsonObject, keys: readonly string[]): JsonObject => {
    const [key = "", ...rest] = keys,
      child = record[key];
    if (!hasKey(record, key)) {
      return record;
    }
    if (isEmpty(rest)) {
      return Object.fromEntries(entriesOf(record).filter(([name]) => name !== key));
    }
    if (!isRecord(child)) {
      return record;
    }
    return Object.fromEntries([...entriesOf(record), [key, withoutPath(child, rest)]]);
  },
  // A role written as just its provider ("codex") becomes { "provider": "codex" } before one of its fields changes.
  withRoleSpec = (config: JsonObject, keys: readonly string[]): JsonObject => {
    const [section = "", role = ""] = keys,
      spec = recordOf(config, "roles")[role];
    if (section !== "roles" || typeof spec !== "string") {
      return config;
    }
    return withPath(config, ["roles", role], { provider: spec });
  },
  // A value as the config file keeps it: a flag, the providers' list, a number for a limit, or text.
  valueFor = (key: string, keys: readonly string[], text: string): JsonValue => {
    const field = lastOf(keys) ?? "";
    if (field === "network" || field === "allowSameReviewer" || key.startsWith("seeds.")) {
      if (text !== "true" && text !== "false") {
        return fail(`${key} must be true or false`);
      }
      return text === "true";
    }
    if (key === "providers") {
      return text
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    }
    if (key.startsWith("limits.")) {
      return Number(text);
    }
    return text;
  },
  pathOrFail = (key: string): readonly string[] => {
    const keys = keyPath(key);
    if (isEmpty(keys)) {
      return fail(`unknown key "${key}". ${KEY_HELP}`);
    }
    return keys;
  },
  setKey = (config: JsonObject, key: string, text: string): JsonObject => {
    const keys = pathOrFail(key);
    return withPath(withRoleSpec(config, keys), keys, valueFor(key, keys, text));
  },
  unsetKey = (config: JsonObject, key: string): JsonObject => {
    const keys = pathOrFail(key);
    return withoutPath(withRoleSpec(config, keys), keys);
  };

export { KEY_HELP, setKey, unsetKey, withPath };
