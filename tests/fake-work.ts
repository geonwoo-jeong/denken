/*
 * A worker's call: it writes the files its prompt lists under Write (the TODO lists as the step or
 * the unit's request says, else a stub report), edits the project as the step says, and in the dev
 * stage changes its file and ticks its items off; in the wiki stage it adds to docs.md.
 */
import { DEFAULT_TODO_DEV, DEFAULT_TODO_QA } from "./fake-plan.ts";
import type { Final, Plan, Played } from "./fake-types.ts";
import { appendInto, appendTo, hardLinkInto, linkInto, removeFile, writeInto, writeTo } from "./fake-io.ts";
import { at, isRecord, textAt } from "./test-json.ts";
import { givenAt, stringsAt, truthyAt } from "./fake-values.ts";
import { groupOf } from "./fake-text.ts";
import path from "node:path";
import { planFromRequest } from "./fake-unit-plan.ts";
import { tickItems } from "./fake-ticks.ts";

const NO_PLAN: Plan = { dev: DEFAULT_TODO_DEV, qa: DEFAULT_TODO_QA },
  inProject = (file: string): string => path.join(process.cwd(), file),
  writesOf = (prompt: string): readonly string[] =>
    groupOf(/- Write:\n(?<list>(?: {2}- .+\n?)+)/u, prompt, "list")
      .split("\n")
      .map((line) => line.replace(/^ {2}- /u, "").trim())
      .filter(Boolean),
  planOf = (played: Played): Plan => {
    if (played.call.unit) {
      return planFromRequest(played);
    }
    return NO_PLAN;
  },
  textOr = (played: Played, key: string, fallback: string): string => {
    if (givenAt(played.step, key)) {
      return textAt(played.step, key);
    }
    return fallback;
  },
  contentFor = (played: Played, name: string): string => {
    if (name === "todo-dev.md") {
      return textOr(played, "todoDev", planOf(played).dev);
    }
    if (name === "todo-qa.md") {
      return textOr(played, "todoQa", planOf(played).qa);
    }
    if (name === "dev-report.md" && truthyAt(played.step, "report")) {
      return textAt(played.step, "report");
    }
    return `# ${played.call.role} round ${played.call.round}\n`;
  },
  // A step's path: in the project, or in the run directory when it starts with "$RUN/".
  stepPath = (played: Played, file: string): string => {
    if (file.startsWith("$RUN/")) {
      return path.join(played.call.runDir, file.slice("$RUN/".length));
    }
    return inProject(file);
  },
  // Paths the step replaces by symlinks, then by hard links.
  linkProject = async (played: Played): Promise<void> => {
    const links = at(played.step, "linkFiles"),
      hard = at(played.step, "hardLinkFiles");
    if (isRecord(links)) {
      await Promise.all(
        Object.keys(links).map(async (file) => {
          await linkInto(stepPath(played, file), textAt(links, file));
        }),
      );
    }
    if (isRecord(hard)) {
      await Promise.all(
        Object.keys(hard).map(async (file) => {
          await hardLinkInto(stepPath(played, file), textAt(hard, file));
        }),
      );
    }
  },
  // The project edits a step asks for: files written, deleted, replaced by symlinks and appended to, in that order.
  editProject = async (played: Played): Promise<void> => {
    const edits = at(played.step, "editFiles"),
      appends = at(played.step, "appendFiles");
    if (isRecord(edits)) {
      await Promise.all(
        Object.keys(edits).map(async (file) => {
          await writeInto(inProject(file), textAt(edits, file));
        }),
      );
    }
    await Promise.all(
      stringsAt(played.step, "removeFiles").map(async (file) => {
        await removeFile(inProject(file));
      }),
    );
    await linkProject(played);
    if (isRecord(appends)) {
      await Promise.all(
        Object.keys(appends).map(async (file) => {
          await appendTo(inProject(file), textAt(appends, file));
        }),
      );
    }
  },
  workFinal = async (played: Played): Promise<Final> => {
    const writes = writesOf(played.call.prompt);
    await Promise.all(
      writes.map(async (file) => {
        await writeTo(file, contentFor(played, path.basename(file)));
      }),
    );
    await editProject(played);
    if (played.call.stage === "dev") {
      await appendInto(path.join(process.cwd(), played.call.devFile), `change ${played.call.round}\n`);
      await tickItems(played);
    }
    if (played.call.stage === "wiki") {
      await appendTo(path.join(process.cwd(), "docs.md"), `doc ${played.call.round}\n`);
    }
    return `${played.call.role} wrote ${writes.join(", ")}`;
  };

export { workFinal };
