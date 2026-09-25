/*
 * Which AI provider (and optionally which model and effort) plays each DENKEN role, resolved from the
 * defaults and the config files, with the providers probed and the separation of workers and checkers
 * checked. Errors stop a run from starting; warnings are shown.
 */
import { brokenResult, resolveFrom } from "./config-result.ts";
import type { ConfigPaths } from "./types-work.ts";
import type { ConfigResult } from "./types-config.ts";
import type { Resolution } from "./types-partc.ts";
import { envText } from "./env.ts";
import { homedir } from "node:os";
import path from "node:path";
import { readLayers } from "./config-layers.ts";

const configPaths = (root: string): ConfigPaths => ({
    global: path.join(envText("XDG_CONFIG_HOME") || path.join(homedir(), ".config"), "denken", "config.json"),
    local: path.join(root, ".denken", "config.local.json"),
    shared: path.join(root, ".denken", "config.json"),
  }),
  // The resolved configuration, and whether the providers were probed (not when a file is invalid JSON).
  resolveDetailed = async (root: string): Promise<Resolution> => {
    const layers = await readLayers(configPaths(root)),
      broken = layers.find((layer) => layer.error);
    if (broken) {
      return { probed: false, result: brokenResult(broken.error) };
    }
    return { probed: true, result: await resolveFrom(root, layers) };
  },
  resolveConfig = async (root: string): Promise<ConfigResult> => {
    const { result } = await resolveDetailed(root);
    return result;
  };

export { configPaths, resolveConfig, resolveDetailed };
