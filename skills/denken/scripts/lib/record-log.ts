/*
 * The work record (ai-log) every run keeps in the project, written by the engine as the run goes:
 *   ai-log/<YYYYMMDD>/<NNN>_<HHMMSS>_<name>/
 *     00-request/      request.md: DENKEN's summary of the conversation (the raw conversation is in raw/)
 *     01-planning/     METHODE <-> RICHTER, one numbered file per step
 *     02-development/  STARK <-> UBEL, including recovery rounds after QA failures
 *     03-qa/           GENAU's report and evidence, one folder per QA cycle
 *     04-wiki/         SERIE <-> FRIEREN
 *     raw/             every call's prompt, streamed log and output, as exchanged
 *     timeline.md      every step, verdict, stop and resume, in order
 *     verdicts.md      every submission and verdict exchanged, in the words it was given
 */
import { NONE, increment } from "./lists.ts";
import { START, clock, groupOf, pad } from "./text.ts";
import { appendText, exists, listNames, makeDir, writeText } from "./files.ts";
import { ROOT } from "./paths.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import type { Stage } from "./types-names.ts";
import path from "node:path";

interface Step {
  readonly content: string;
  readonly name: string;
  readonly stage: Stage;
}

const DAY_WIDTH = 2,
  SEQ_WIDTH = 3,
  STEP_WIDTH = 2,
  TITLE_MAX = 60,
  CLOCK_LENGTH = 8,
  MONTH_OFFSET = 1,
  STAGE_LOG: Readonly<Record<Stage, string>> = { dev: "02-development", plan: "01-planning", qa: "03-qa", wiki: "04-wiki" },
  LOG_DIRS: readonly string[] = ["00-request", STAGE_LOG.plan, STAGE_LOG.dev, STAGE_LOG.qa, STAGE_LOG.wiki, "raw"],
  verdictsHead = (task: string): string =>
    `# Verdicts: ${task}\n\nEvery submission and verdict exchanged in this run, in order, in the words it was given. Each line links the step file that holds the full text. The engine alone writes this file.\n\n`,
  /*
   * A unit's run keeps the parent's record, by absolute path, and writes into a folder of its own
   * within each part of it: 01-planning/UNIT-1/, raw/UNIT-1/, and so on.
   */
  logDir = (state: RunState): string => {
    if (state.log) {
      return path.resolve(ROOT, state.log);
    }
    return "";
  },
  logPart = (state: RunState, part: string): string => {
    if (state.unit) {
      return path.join(part, state.unit);
    }
    return part;
  },
  dayOf = (moment: Readonly<Date>): string =>
    `${moment.getFullYear()}${pad(moment.getMonth() + MONTH_OFFSET, DAY_WIDTH)}${pad(moment.getDate(), DAY_WIDTH)}`,
  titleOf = (name: string): string =>
    name
      .normalize("NFC")
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(START, TITLE_MAX) || "run",
  nextSeq = async (dayDir: string): Promise<number> => {
    const names = await listNames(dayDir),
      seqs = names.map((name) => Number(groupOf(/^(?<seq>\d{3})_/u, name, "seq") || NONE));
    return increment(Math.max(NONE, ...seqs));
  },
  // Raw exchanges and QA evidence can hold secrets (environment dumps, tokens in logs): kept out of git.
  ensureLogRoot = async (): Promise<void> => {
    const ignore = path.join(ROOT, "ai-log", ".gitignore");
    await makeDir(path.join(ROOT, "ai-log"));
    if (!(await exists(ignore))) {
      await writeText(ignore, "*/*/raw/\n*/*/03-qa/*/evidence/\n");
    }
  },
  startLog = async (name: string, dir: string): Promise<string> => {
    await Promise.all(
      LOG_DIRS.map(async (sub) => {
        await makeDir(path.join(dir, sub));
      }),
    );
    await writeText(path.join(dir, "timeline.md"), `# Timeline: ${name}\n\nEvery step, verdict, stop and resume of this run, in order.\n\n`);
    await writeText(path.join(dir, "verdicts.md"), verdictsHead(name));
    return path.relative(ROOT, dir);
  },
  // The run's folder name: its number that day, the time and the task's title.
  folderName = (moment: Readonly<Date>, seq: number, name: string): string =>
    `${pad(seq, SEQ_WIDTH)}_${moment.toTimeString().slice(START, CLOCK_LENGTH).replaceAll(":", "")}_${titleOf(name)}`,
  createLog = async (name: string): Promise<string> => {
    const moment = new Date(),
      dayDir = path.join(ROOT, "ai-log", dayOf(moment)),
      seq = await nextSeq(dayDir);
    await ensureLogRoot();
    await makeDir(dayDir);
    return startLog(name, path.join(dayDir, folderName(moment, seq, name)));
  },
  whoOf = (state: RunState, actor: string): string => {
    if (state.unit) {
      return `${state.unit} · ${actor}`;
    }
    return actor;
  },
  timeline = async (store: RunStore, actor: string, text: string): Promise<void> => {
    const state = store.current(),
      dir = logDir(state);
    if (dir) {
      await appendText(path.join(dir, "timeline.md"), `- ${clock()} · **${whoOf(state, actor)}** · ${text}\n`);
    }
  },
  writeStep = async (folder: string, part: string, step: Step): Promise<string> => {
    const names = await listNames(folder),
      file = `${pad(increment(names.filter((name) => /^\d{2}_/u.test(name)).length), STEP_WIDTH)}_${step.name}.md`;
    await writeText(path.join(folder, file), step.content);
    return `${part}/${file}`;
  },
  // One numbered file per step in a stage folder; returns its path within the log.
  logStep = async (store: RunStore, step: Step): Promise<string> => {
    const state = store.current(),
      dir = logDir(state),
      part = logPart(state, STAGE_LOG[step.stage]),
      folder = path.join(dir, part);
    if (!dir) {
      return "";
    }
    await makeDir(folder);
    return writeStep(folder, part, step);
  };

export { createLog, LOG_DIRS, logDir, logPart, logStep, STAGE_LOG, timeline, verdictsHead };
