// Merging the config files: allowed providers, limits, FLAMME's seeds, allowSameReviewer and the roles' specs.
import type { Checked, ConfigLayer } from "./types-partc.ts";
import { DEFAULT_LIMITS, DEFAULT_SEEDS, SUPPORTED, isProvider } from "./config-defaults.ts";
import { EMPTY, asRecord, isList, numberOf, recordOf } from "./json.ts";
import type { JsonObject, JsonValue } from "./types-json.ts";
import type { Limits, SeedSwitches } from "./types-config.ts";
import { entriesOf, withEntry } from "./lists.ts";
import { lastSet, shown } from "./config-layers.ts";
import type { TextMap } from "./types-names.ts";

type LimitKey = keyof Limits;

const LIMIT_KEYS: readonly LimitKey[] = ["topicRepeats", "roundsPerStage", "callTimeoutMin", "parallelUnits"],
  POSITIVE = 0,
  LEAST = 1,
  whole = (data: JsonObject): JsonObject => data,
  // The providers DENKEN may use: the last file that names them, else every supported one.
  providersIn = (value: JsonValue | undefined): readonly string[] => {
    if (isList(value)) {
      return value.map((item) => shown(item));
    }
    return [shown(value)];
  },
  allowedOf = (layers: readonly ConfigLayer[]): readonly string[] => {
    const [set] = lastSet(layers, whole, "providers");
    if (!set) {
      return SUPPORTED;
    }
    return providersIn(set["providers"]);
  },
  allowSameOf = (layers: readonly ConfigLayer[]): boolean => lastSet(layers, whole, "allowSameReviewer").some((set) => set["allowSameReviewer"] === true),
  // Every file's entries under one key, later files overriding earlier ones, in the order keys first appear.
  merged = (layers: readonly ConfigLayer[], key: string, defaults: readonly (readonly [string, JsonValue])[]): JsonObject =>
    Object.fromEntries([...defaults, ...layers.flatMap((layer) => entriesOf(recordOf(layer.data, key)))]),
  limitProblem = (key: string, value: JsonValue | undefined): string => {
    if (!LIMIT_KEYS.some((known) => known === key)) {
      return `unknown limit "${key}"`;
    }
    if (key === "callTimeoutMin" && !(typeof value === "number" && value > POSITIVE)) {
      return "limits.callTimeoutMin must be a positive number";
    }
    if (key !== "callTimeoutMin" && !(typeof value === "number" && Number.isInteger(value) && value >= LEAST)) {
      return `limits.${key} must be a positive integer`;
    }
    return "";
  },
  // A limit as configured: a number is kept even when it is refused (the error says so), anything else is the default.
  configuredLimit = (values: JsonObject, key: LimitKey): number => numberOf(values, key, DEFAULT_LIMITS[key]),
  limitsOf = (layers: readonly ConfigLayer[]): Checked<Limits> => {
    const values = merged(layers, "limits", LIMIT_KEYS.map((key) => [key, DEFAULT_LIMITS[key]] as const)),
      errors = entriesOf(values).map(([key, value]) => limitProblem(key, value)).filter(Boolean);
    return {
      errors,
      value: {
        callTimeoutMin: configuredLimit(values, "callTimeoutMin"),
        parallelUnits: configuredLimit(values, "parallelUnits"),
        roundsPerStage: configuredLimit(values, "roundsPerStage"),
        topicRepeats: configuredLimit(values, "topicRepeats"),
      },
    };
  },
  seedProblem = (provider: string, on: JsonValue): string => {
    if (!isProvider(provider)) {
      return `seeds.${provider}: unsupported provider`;
    }
    if (typeof on !== "boolean") {
      return `seeds.${provider} must be true or false`;
    }
    return "";
  },
  seedFlag = (values: JsonObject, provider: "claude" | "codex"): boolean => {
    const on = values[provider];
    if (typeof on === "boolean") {
      return on;
    }
    return DEFAULT_SEEDS[provider];
  },
  seedsOf = (layers: readonly ConfigLayer[]): Checked<SeedSwitches> => {
    const values = merged(layers, "seeds", [
        ["claude", DEFAULT_SEEDS.claude],
        ["codex", DEFAULT_SEEDS.codex],
      ]);
    return {
      errors: entriesOf(values)
        .map(([provider, on]) => seedProblem(provider, on))
        .filter(Boolean),
      value: { claude: seedFlag(values, "claude"), codex: seedFlag(values, "codex") },
    };
  },
  // A role's spec: "codex" is short for { "provider": "codex" }.
  asSpec = (value: JsonValue): JsonObject => {
    if (typeof value === "string") {
      return { provider: value };
    }
    return asRecord(value);
  },
  roleSpecsOf = (layers: readonly ConfigLayer[]): TextMap<JsonObject> => {
    let specs: TextMap<JsonObject> = {};
    for (const [role, value] of layers.flatMap((layer) => entriesOf(recordOf(layer.data, "roles")))) {
      specs = withEntry(specs, role, Object.assign(structuredClone(specs[role] ?? EMPTY), asSpec(value)));
    }
    return specs;
  };

export { allowedOf, allowSameOf, asSpec, LIMIT_KEYS, limitsOf, roleSpecsOf, seedsOf };
