// Start's choices: the providers FLAMME seeds for, and levels that keep every checker apart from the work it checks.
import type { ConfigResult, Provider } from "./types-config.ts";
import { SUPPORTED, isProvider } from "./config-defaults.ts";
import { entriesOf, hasItems, patch } from "./lists.ts";
import { fail, stop } from "./output.ts";
import type { RunState } from "./types-run.ts";
import type { UnitPlan } from "./types-units.ts";
import { choiceProblems } from "./levels.ts";

const STEP_TO_VALUE = 1,
  // DENKEN can turn seeds off for a small task (start --seeds off), or name the providers to seed.
  seedingOf = (args: readonly string[], config: ConfigResult): readonly Provider[] => {
    const at = args.indexOf("--seeds"),
      value = args[at + STEP_TO_VALUE] ?? "",
      named = value.split(",");
    if (!args.includes("--seeds")) {
      return SUPPORTED.filter((provider) => config.seeds[provider]);
    }
    if (value === "off") {
      return [];
    }
    if (!named.every((name) => isProvider(name))) {
      fail("--seeds takes off, or the providers to seed: claude, codex, or claude,codex");
    }
    return named.filter((name) => isProvider(name));
  },
  // The levels DENKEN picked apply to every unit too, unless the unit's own line changes them.
  checkUnitLevels = (state: RunState, units: readonly UnitPlan[]): void => {
    for (const unit of units) {
      const levels = Object.fromEntries([...entriesOf(state.levels), ...entriesOf(unit.levels)]),
        [problem = ""] = choiceProblems(patch(state, { levels }));
      if (problem) {
        fail(`${unit.id}'s levels: ${problem}`);
      }
    }
  },
  checkChoices = (state: RunState, units: readonly UnitPlan[]): void => {
    const chosen = choiceProblems(state);
    checkUnitLevels(state, units);
    if (chosen.some((problem) => problem.includes("same model"))) {
      stop("same_reviewer", {
        action: "needs_user",
        next: "The same model would check its own work. Give the checker a different level (start --level <role>=<level>), or ask the user to set a different model or effort for it with config.ts, or to set allowSameReviewer true. Then run start again.",
        problems: chosen,
        reason: "same_reviewer",
      });
    }
    if (hasItems(chosen)) {
      fail(chosen.join("; "));
    }
  };

export { checkChoices, seedingOf };
