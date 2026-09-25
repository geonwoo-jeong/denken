// The rule command's arguments: the decision, and the note that explains it (inline or from a file).
import { fail } from "./output.ts";
import { readTextOr } from "./files.ts";

const DECISIONS: ReadonlySet<string> = new Set(["abort", "dismiss", "replan", "uphold"]),
  VALUE_OFFSET = 1,
  valueOf = (args: readonly string[], flag: string): string => {
    if (!args.includes(flag)) {
      return "";
    }
    return args[args.indexOf(flag) + VALUE_OFFSET] ?? "";
  },
  decisionOf = (args: readonly string[]): string => {
    const decision = valueOf(args, "--decision");
    if (!DECISIONS.has(decision)) {
      fail("--decision must be uphold, dismiss, replan or abort");
    }
    return decision;
  },
  noteText = async (args: readonly string[]): Promise<string> => {
    if (args.includes("--note")) {
      return valueOf(args, "--note");
    }
    const text = await readTextOr(valueOf(args, "--note-file"), "");
    return text;
  },
  noteOf = async (args: readonly string[]): Promise<string> => {
    const note = await noteText(args);
    if (!note.trim()) {
      fail("a ruling needs --note <text> or --note-file <path> explaining the decision and the direction");
    }
    return note;
  };

export { decisionOf, noteOf, valueOf };
