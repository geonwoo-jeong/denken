/*
 * The levels DENKEN picks, read from the command line: "--level plan=light" (a stage's roles, or one
 * role), "--model stark=<id>", "--effort ubel=high"; the levels command also takes bare "dev=heavy".
 */
import type { ChoicePair, LevelChoice, OverrideChoice } from "./types-partc.ts";
import { FIRST, entriesOf, increment, isEmpty } from "./lists.ts";
import { LEVELS, isLevel } from "./config-defaults.ts";
import { ROLE_NAMES, isChecker, rolesOf } from "./levels.ts";
import type { Choices } from "./types-work.ts";
import type { Override } from "./types-progress.ts";
import { STAGES } from "./stage-table.ts";
import { fail } from "./output.ts";

const CHOICE_FLAGS: ReadonlySet<string> = new Set(["--level", "--model", "--effort"]),
  FLAG_PREFIX = "--",
  FLAG_AND_VALUE = 2,
  ONE_ROLE = 1,
  BARE_PAIR = /^[a-z]+=\S+$/u,
  NO_OVERRIDE: Override = { effort: "", model: "" },
  // The level and override pairs in the arguments; any other flag's value is skipped.
  scanPairs = (args: readonly string[], index: number): readonly ChoicePair[] => {
    const arg = args[index];
    if (typeof arg !== "string") {
      return [];
    }
    if (CHOICE_FLAGS.has(arg)) {
      return [{ kind: arg.slice(FLAG_PREFIX.length), text: args[increment(index)] ?? "" }, ...scanPairs(args, index + FLAG_AND_VALUE)];
    }
    if (arg.startsWith(FLAG_PREFIX)) {
      return scanPairs(args, index + FLAG_AND_VALUE);
    }
    if (BARE_PAIR.test(arg)) {
      return [{ kind: "level", text: arg }, ...scanPairs(args, increment(index))];
    }
    return scanPairs(args, increment(index));
  },
  withLevel = (choices: Choices, choice: LevelChoice): Choices => {
    const { key, roles, value } = choice;
    if (!isLevel(value)) {
      return fail(`a level is one of ${LEVELS.join(", ")} (got ${key}=${value})`);
    }
    // "plan=light" makes the planner light; its reviewer stays at standard.
    if (value === "light" && roles.every((role) => isChecker(role))) {
      return fail(`${key} checks other work (${roles.join(", ")}), and a checker never runs below standard`);
    }
    return {
      levels: Object.fromEntries([...entriesOf(choices.levels), ...roles.filter((role) => !(value === "light" && isChecker(role))).map((role) => [role, value] as const)]),
      overrides: choices.overrides,
    };
  },
  overrideWith = (current: Override, choice: OverrideChoice): Override => {
    if (choice.kind === "model") {
      return { effort: current.effort, model: choice.value };
    }
    return { effort: choice.value, model: current.model };
  },
  withOverride = (choices: Choices, choice: OverrideChoice): Choices => {
    if (choice.kind === "model" && choice.roles.length > ONE_ROLE) {
      return fail("--model names one role: a stage's worker and reviewer may run on different providers");
    }
    return {
      levels: choices.levels,
      overrides: Object.fromEntries([
        ...entriesOf(choices.overrides),
        ...choice.roles.map((role) => [role, overrideWith(choices.overrides[role] ?? NO_OVERRIDE, choice)] as const),
      ]),
    };
  },
  applyPair = (choices: Choices, pair: ChoicePair): Choices => {
    const [key = "", value = ""] = pair.text.split("="),
      roles = rolesOf(key);
    if (isEmpty(roles) || !value) {
      return fail(`--${pair.kind} takes <stage or role>=<value>. Stages: ${STAGES.join(", ")}; roles: ${ROLE_NAMES.join(", ")}`);
    }
    if (pair.kind === "level") {
      return withLevel(choices, { key, roles, value });
    }
    return withOverride(choices, { key, kind: pair.kind, roles, value });
  },
  parseChoices = (args: readonly string[], current: Choices): Choices => {
    let choices = current;
    for (const pair of scanPairs(args, FIRST)) {
      choices = applyPair(choices, pair);
    }
    return choices;
  };

export { parseChoices };
