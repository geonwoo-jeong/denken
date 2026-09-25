// Start's configuration and split: the resolved assignment, and units.md when DENKEN split the request.
import { ROOT, UNITS } from "./paths.ts";
import { fail, stop } from "./output.ts";
import type { ConfigResult } from "./types-config.ts";
import type { UnitsCheck } from "./types-units.ts";
import { exists } from "./files.ts";
import { hasItems } from "./lists.ts";
import path from "node:path";
import { resolveConfig } from "./config-resolve.ts";
import { unitsProblems } from "./units-plan.ts";

const configOrStop = async (): Promise<ConfigResult> => {
    const config = await resolveConfig(ROOT);
    if (hasItems(config.errors)) {
      stop("config", { action: "needs_user", errors: config.errors, next: "Fix the configuration with config.ts, then run start again.", reason: "config", warnings: config.warnings });
    }
    return config;
  },
  // No units.md means no split: the request runs as one.
  splitOf = async (runDir: string): Promise<UnitsCheck> => {
    if (!(await exists(path.join(runDir, UNITS)))) {
      return { problems: [], units: [] };
    }
    const check = await unitsProblems(runDir);
    if (hasItems(check.problems)) {
      fail(`${UNITS}: ${check.problems.join("; ")}`);
    }
    return check;
  };

export { configOrStop, splitOf };
