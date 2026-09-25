// The grant and deny commands' arguments: the note, the user's words, and what is granted.
import type { Grants } from "./types-config.ts";
import { ROOT } from "./paths.ts";
import path from "node:path";
import { valueOf } from "./rule-args.ts";

const VALUE_OFFSET = 1,
  textFlag = (args: readonly string[], flag: string): string => valueOf(args, flag).trim(),
  // Every value given after a repeated flag.
  allOf = (args: readonly string[], flag: string): readonly string[] =>
    args.flatMap((arg, index) => {
      const value = args[index + VALUE_OFFSET] ?? "";
      if (arg === flag && value) {
        return [value];
      }
      return [];
    }),
  grantOf = (args: readonly string[]): Grants => ({
    dirs: allOf(args, "--dir").map((dir) => path.resolve(ROOT, dir)),
    domains: allOf(args, "--domain"),
    network: args.includes("--network"),
    tools: allOf(args, "--tool"),
  });

export { grantOf, textFlag };
