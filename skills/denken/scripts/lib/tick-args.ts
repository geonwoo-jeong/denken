// The tick command's arguments: tick <run> <DEV-001|FIX-001> (--evidence <text> | --no-change <why>) -- <command> <args...>
import { START } from "./text.ts";
import type { TickArgs } from "./types-tick.ts";
import { fail } from "./output.ts";
import { isEmpty } from "./lists.ts";

const VALUE_OFFSET = 1,
  ITEM_KEY = /^(?:DEV|FIX)-\d{3,}$/u,
  USAGE = 'usage: tick <run> <DEV-001|FIX-001> (--evidence "<what was done, and where>" | --no-change "<why the item needs no change>") -- <command> <args...>',
  headOf = (args: readonly string[]): readonly string[] => {
    if (!args.includes("--")) {
      return args;
    }
    return args.slice(START, args.indexOf("--"));
  },
  // The command runs as the argv given, with no shell, so "|| true" or "; exit 0" cannot turn a failure into a tick.
  commandOf = (args: readonly string[]): readonly string[] => {
    if (!args.includes("--")) {
      return [];
    }
    return args.slice(args.indexOf("--") + VALUE_OFFSET);
  },
  optionOf = (head: readonly string[], name: string): string => {
    if (!head.includes(name)) {
      return "";
    }
    return (head[head.indexOf(name) + VALUE_OFFSET] ?? "").trim();
  },
  tickArgs = (args: readonly string[]): TickArgs => {
    const [item = ""] = args,
      argv = commandOf(args),
      evidence = optionOf(headOf(args), "--evidence"),
      noChange = optionOf(headOf(args), "--no-change");
    if (!ITEM_KEY.test(item) || isEmpty(argv) || Boolean(evidence) === Boolean(noChange)) {
      fail(USAGE);
    }
    return { argv, evidence, item, noChange };
  };

export { tickArgs };
