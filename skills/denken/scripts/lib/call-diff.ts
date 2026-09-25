// The diff a reviewer reads: the stage's changes since it began, written next to the call's other files.
import { EMPTY_TREE, EXCLUDE, callBase } from "./paths.ts";
import type { CallSpec } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { gitBinary } from "./git.ts";
import { writeBinary } from "./files.ts";

// The stage's diff since it began, with the untracked files listed after it.
const writeDiff = async (store: RunStore, call: CallSpec & { readonly id: string }): Promise<string> => {
    const file = `${callBase(store.dir, call.id)}.diff`,
      base = store.current().stageBase[call.stage] || EMPTY_TREE,
      diff = await gitBinary(["diff", base, "--", ".", ...EXCLUDE]),
      untracked = await gitBinary(["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE]);
    await writeBinary(file, `${diff}\n# Untracked files (read them directly)\n${untracked}`);
    return file;
  },
  diffReads = async (store: RunStore, call: CallSpec & { readonly id: string }): Promise<readonly string[]> => {
    if (call.stage === "plan") {
      return [];
    }
    return [await writeDiff(store, call)];
  };

export { diffReads };
