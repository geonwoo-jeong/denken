/*
 * The config files, later ones overriding earlier ones:
 *   ~/.config/denken/config.json   --global  personal defaults for every project
 *   .denken/config.json            (default) shared with the team; commit it
 *   .denken/config.local.json      --local   personal override for this project; not committed
 */
import { asRecord, hasKey, parseJson } from "./json.ts";
import { exists, readTextOr } from "./files.ts";
import type { ConfigLayer } from "./types-partc.ts";
import type { ConfigPaths } from "./types-work.ts";
import type { JsonObject } from "./types-json.ts";
import { LAST } from "./lists.ts";

// A config file: its values (none when it does not exist); invalid JSON is an error that stops the resolution.
const readLayer = async (file: string): Promise<ConfigLayer> => {
    if (!(await exists(file))) {
      return { data: {}, error: "", path: file, present: false };
    }
    const parsed = parseJson(await readTextOr(file, ""));
    if (!parsed.ok) {
      return { data: {}, error: `${file} is not valid JSON: ${parsed.error}`, path: file, present: false };
    }
    return { data: asRecord(parsed.value), error: "", path: file, present: parsed.value !== null && parsed.value !== false };
  },
  readLayers = async (paths: ConfigPaths): Promise<readonly ConfigLayer[]> => {
    const layers = await Promise.all([readLayer(paths.global), readLayer(paths.shared), readLayer(paths.local)]);
    return layers;
  },
  // The value the last file that sets a key gives it (a null counts as not set): none or one.
  lastSet = (layers: readonly ConfigLayer[], read: (data: JsonObject) => JsonObject, key: string): readonly JsonObject[] =>
    layers
      .map((layer) => read(layer.data))
      .filter((data) => hasKey(data, key) && data[key] !== null)
      .slice(LAST),
  // A config value as text, the way it would read in a message.
  shown = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    return JSON.stringify(value);
  };

export { lastSet, readLayers, shown };
