/*
 * DENKEN changes levels mid-run, for example to give a stage that keeps failing a stronger model;
 * calls launched from now on use them.
 */
import { fail, print } from "./output.ts";
import type { RunStore } from "./types-store.ts";
import { assertLock } from "./lock.ts";
import { choose } from "./levels-change.ts";
import { hasItems } from "./lists.ts";
import { oneLine } from "./text.ts";
import { roleAgents } from "./levels.ts";
import { textFlag } from "./permission-args.ts";
import { timeline } from "./record-log.ts";
import { verdict } from "./record-verdicts.ts";

const NOTE_MAX = 200,
  FINISHED: ReadonlySet<string> = new Set(["aborted", "done", "intake"]),
  checkLevels = (store: RunStore, note: string): void => {
    const { stage } = store.current();
    if (FINISHED.has(stage)) {
      fail(`levels apply to a started run that is not finished (stage: ${stage}); at the start, pass them to start`);
    }
    if (!note) {
      fail('say why: levels <run> <stage or role>=<level>... [--model <role>=<id>] [--effort <role>=<value>] --note "<why>"');
    }
  },
  cmdLevels = async (store: RunStore, args: readonly string[]): Promise<void> => {
    checkLevels(store, textFlag(args, "--note"));
    const note = textFlag(args, "--note"),
      changed = choose(store, args);
    if (!hasItems(changed)) {
      fail("nothing changes: every role already runs as asked");
    }
    await timeline(store, "DENKEN", `levels changed for the calls from now on: ${changed.join("; ")}. ${oneLine(note, NOTE_MAX)}`);
    await verdict(store, { label: "Levels", text: `${changed.join("; ")}: ${note}`, who: "DENKEN", word: "SET" });
    await assertLock();
    await store.save();
    print({ action: "levels", next: "Calls launched from now on use these. Run next with --wait.", roles: roleAgents(store.current()) });
  };

export { cmdLevels };
