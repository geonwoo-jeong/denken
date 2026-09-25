/*
 * The run's verdicts.md: one line per submission or verdict, with the words it was given in. The
 * lines live in state.json and the file is rewritten from them on every entry, so the engine is its
 * only writer: a copy changed by anyone else is kept in raw/, noted, and replaced.
 */
import { clock, framed, oneLine, sha, stamp } from "./text.ts";
import { copyInto, exists, hashFile, writeText } from "./files.ts";
import { logDir, timeline, verdictsHead } from "./record-log.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import type { Stage } from "./types-names.ts";
import { appended } from "./lists.ts";
import path from "node:path";

// A verdict line: who said which word about what, with the call and step file it came from.
interface Verdict {
  readonly call?: string;
  readonly file?: string;
  readonly label: string;
  readonly note?: string;
  readonly text: string;
  readonly who: string;
  readonly word: string;
}

const SHOWN_MAX = 1000,
  STAGE_NAME: Readonly<Record<Stage, string>> = { dev: "Development", plan: "Planning", qa: "QA", wiki: "Docs" },
  // A changed verdicts.md is kept in raw/ before it is rewritten, and the change is recorded.
  pushVerdict = (store: RunStore, line: string): RunState => {
    const { verdicts } = store.current();
    return store.apply({ verdicts: appended(verdicts, line) });
  },
  keepChanged = async (store: RunStore, file: string): Promise<void> => {
    const kept = `raw/verdicts.changed-${stamp()}.md`,
      dir = logDir(store.current());
    if (await exists(file)) {
      await copyInto(file, path.join(dir, kept));
    }
    pushVerdict(
      store,
      `- ${clock()} · Record · ENGINE · **RESTORED** · verdicts.md was changed outside the engine; it was rewritten from the engine's own record, and the changed copy kept → ${kept}`,
    );
    await timeline(store, "ENGINE", `verdicts.md was changed outside the engine: restored, changed copy kept → ${kept}`);
  },
  saveVerdicts = async (store: RunStore, line: string): Promise<void> => {
    const state = pushVerdict(store, line),
      content = `${verdictsHead(state.task)}${state.verdicts.join("\n")}\n`;
    // A unit's lines are pulled into the parent's verdicts.md by the parent, the file's only writer.
    if (!state.unit) {
      await writeText(path.join(logDir(state), "verdicts.md"), content);
      store.apply({ verdictsSha: sha(content) });
    }
  },
  writeVerdicts = async (store: RunStore, line: string): Promise<void> => {
    const state = store.current(),
      file = path.join(logDir(state), "verdicts.md");
    if (!state.unit && state.verdictsSha && (await hashFile(file)) !== state.verdictsSha) {
      await keepChanged(store, file);
    }
    await saveVerdicts(store, line);
  },
  truncation = (shown: string, full: string): string => {
    if (shown.length < full.length) {
      return " … (truncated)";
    }
    return "";
  },
  lineOf = (entry: Verdict): string => {
    const full = entry.text.replaceAll(/\s+/gu, " ").trim(),
      shown = oneLine(full, SHOWN_MAX),
      cut = truncation(shown, full);
    return `- ${clock()} · ${entry.label} · ${entry.who}${framed(" · ", entry.call ?? "", "")} · **${entry.word}**${framed(" (", entry.note ?? "", ")")} · ${shown}${cut}${framed(" → ", entry.file ?? "", "")}`;
  },
  verdict = async (store: RunStore, entry: Verdict): Promise<void> => {
    if (logDir(store.current())) {
      await writeVerdicts(store, lineOf(entry));
    }
  };

export { STAGE_NAME, verdict, writeVerdicts };
