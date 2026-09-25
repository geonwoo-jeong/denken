// Saving a changed config file: written, checked by resolving the configuration, and undone when it has errors.
import { EMPTY, asRecord, parseJson, toJson } from "./json.ts";
import { configPaths, resolveDetailed } from "./config-resolve.ts";
import { exists, makeDir, readTextOr, removePath, writeText } from "./files.ts";
import type { JsonObject } from "./types-json.ts";
import { ROOT } from "./paths.ts";
import { fail } from "./output.ts";
import { hasItems } from "./lists.ts";
import path from "node:path";
import { showConfig } from "./config-show.ts";

const GITIGNORE = "runs/\nlocks/\nconfig.local.json\n",
  restore = async (file: string, existed: boolean, previous: string): Promise<void> => {
    if (existed) {
      await writeText(file, previous);
      return;
    }
    await removePath(file);
  },
  configOf = (file: string, text: string): JsonObject => {
    const parsed = parseJson(text);
    if (!text) {
      return EMPTY;
    }
    if (!parsed.ok) {
      return fail(`${file} is not valid JSON: ${parsed.error}`);
    }
    return asRecord(parsed.value);
  },
  writeConfig = async (file: string, config: JsonObject): Promise<void> => {
    const paths = configPaths(ROOT),
      ignore = path.join(path.dirname(paths.shared), ".gitignore");
    await makeDir(path.dirname(file));
    await writeText(file, `${toJson(config)}\n`);
    if (file !== paths.global && !(await exists(ignore))) {
      await writeText(ignore, GITIGNORE);
    }
  },
  // A change that leaves the configuration with errors is undone.
  keepOrRestore = async (file: string, existed: boolean, previous: string): Promise<void> => {
    const { result } = await resolveDetailed(ROOT);
    if (hasItems(result.errors)) {
      await restore(file, existed, previous);
      fail(`not saved:\n  ${result.errors.join("\n  ")}`);
    }
    process.stdout.write(`Saved ${file}\n\n`);
    await showConfig(false);
  },
  update = async (file: string, change: (config: JsonObject) => JsonObject): Promise<void> => {
    const existed = await exists(file),
      previous = await readTextOr(file, ""),
      config = change(configOf(file, previous));
    await writeConfig(file, config);
    await keepOrRestore(file, existed, previous);
  };

export { update };
