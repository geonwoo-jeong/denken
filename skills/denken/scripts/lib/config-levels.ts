/*
 * What a level means on each provider, from the defaults and the config files. Only light and heavy
 * can be configured: standard is always the role's own model and effort.
 */
import type { Checked, ConfigLayer, LevelEvent } from "./types-partc.ts";
import { DEFAULT_LEVELS, EFFORTS, isProvider } from "./config-defaults.ts";
import { EMPTY, asRecord, hasKey, recordOf, textOf } from "./json.ts";
import type { JsonObject, JsonValue } from "./types-json.ts";
import type { LevelSpec, LevelTable, Provider } from "./types-config.ts";
import { entriesOf, withEntry } from "./lists.ts";
import type { TextMap } from "./types-names.ts";

interface LevelKey {
  readonly key: string;
  readonly level: "heavy" | "light";
  readonly provider: Provider;
}

const specJson = (spec: LevelSpec): JsonObject => ({ effort: spec.effort, model: spec.model }),
  DEFAULT_RAW: TextMap<JsonObject> = {
    "claude.heavy": specJson(DEFAULT_LEVELS.claude.heavy),
    "claude.light": specJson(DEFAULT_LEVELS.claude.light),
    "codex.heavy": specJson(DEFAULT_LEVELS.codex.heavy),
    "codex.light": specJson(DEFAULT_LEVELS.codex.light),
  },
  // The configurable levels, in the order their problems are reported.
  LEVEL_KEYS: readonly LevelKey[] = [
    { key: "claude.light", level: "light", provider: "claude" },
    { key: "claude.heavy", level: "heavy", provider: "claude" },
    { key: "codex.light", level: "light", provider: "codex" },
    { key: "codex.heavy", level: "heavy", provider: "codex" },
  ],
  levelEvent = (provider: string, level: string, spec: JsonValue): LevelEvent => {
    if (level !== "light" && level !== "heavy") {
      return { error: `levels.${provider}.${level}: only light and heavy can be configured (standard is the role's own model and effort)`, key: "", spec: EMPTY };
    }
    return { error: "", key: `${provider}.${level}`, spec: asRecord(spec) };
  },
  providerEvents = (provider: string, byLevel: JsonValue): readonly LevelEvent[] => {
    if (!isProvider(provider)) {
      return [{ error: `levels.${provider}: unsupported provider`, key: "", spec: EMPTY }];
    }
    return entriesOf(asRecord(byLevel)).map(([level, spec]) => levelEvent(provider, level, spec));
  },
  eventsOf = (layer: ConfigLayer): readonly LevelEvent[] => entriesOf(recordOf(layer.data, "levels")).flatMap(([provider, byLevel]) => providerEvents(provider, byLevel)),
  effortError = (raw: TextMap<JsonObject>, level: LevelKey): string => {
    const spec = raw[level.key] ?? EMPTY,
      { effort } = spec;
    if (!hasKey(spec, "effort") || effort === null || (typeof effort === "string" && EFFORTS[level.provider].includes(effort))) {
      return "";
    }
    return `levels.${level.provider}.${level.level}.effort must be one of ${EFFORTS[level.provider].join(", ")}`;
  },
  specOf = (raw: TextMap<JsonObject>, key: string): LevelSpec => {
    const spec = raw[key] ?? EMPTY;
    return { effort: textOf(spec, "effort"), model: textOf(spec, "model") };
  },
  levelsOf = (layers: readonly ConfigLayer[]): Checked<LevelTable> => {
    const errors: string[] = [];
    let raw = DEFAULT_RAW;
    for (const event of layers.flatMap((layer) => eventsOf(layer))) {
      if (event.error) {
        errors.push(event.error);
      } else {
        raw = withEntry(raw, event.key, Object.assign(structuredClone(raw[event.key] ?? EMPTY), event.spec));
      }
    }
    return {
      errors: [...errors, ...LEVEL_KEYS.map((level) => effortError(raw, level)).filter(Boolean)],
      value: {
        claude: { heavy: specOf(raw, "claude.heavy"), light: specOf(raw, "claude.light") },
        codex: { heavy: specOf(raw, "codex.heavy"), light: specOf(raw, "codex.light") },
      },
    };
  };

export { levelsOf };
