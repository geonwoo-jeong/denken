/*
 * What a worker reads, writes and is told. Who reads what is deliberate: STARK builds from the
 * development TODO alone, and METHODE and SERIE work from the request.
 */
import { DEV_REPORT, REQUEST, SCRIPT, TODO_DEV, TODO_FIX, TODO_QA } from "./paths.ts";
import type { CallParts } from "./types-calls.ts";
import type { CallSpec } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { STEP } from "./lists.ts";
import type { Stage } from "./types-names.ts";
import { artifactsOf } from "./stage-table.ts";
import { fixItems } from "./todo.ts";
import path from "node:path";
import { wikiNote } from "./call-wiki.ts";

const stageReads = (store: RunStore, stage: Stage): readonly string[] => {
    const inRun = (name: string): string => path.join(store.dir, name),
      reads: Readonly<Record<Stage, readonly string[]>> = {
        dev: [inRun(TODO_DEV)],
        plan: [inRun(REQUEST)],
        qa: [],
        wiki: [inRun(REQUEST), inRun(TODO_DEV), inRun(DEV_REPORT), store.current().lastQa],
      };
    return reads[stage];
  },
  // A recovery round reads the recovery TODO; a later round reads the review of the one before.
  feedbackReads = (store: RunStore, call: CallSpec): readonly string[] => {
    const state = store.current(),
      lastReview = state.lastReview[call.stage];
    if (call.stage === "dev" && state.devInput === "qa") {
      return [path.join(store.dir, TODO_FIX)];
    }
    if (call.round > STEP && lastReview) {
      return [lastReview];
    }
    return [];
  },
  tickNote = (runDir: string): string =>
    `When an item is built, tick it off through the engine: node "${SCRIPT}" tick "${runDir}" <DEV-001|FIX-001> --evidence "<what was done, and where: name the files>" -- <command> <args...> (for example: -- node --test test/a.test.js). The command runs as given, without a shell. The tick is recorded only if the command passes and the evidence names a file changed for that item (since its last tick, or since development began). For an item that truly needs no change, pass --no-change "<why>" instead of --evidence. The engine writes the ticks and evidence into ${TODO_DEV} and ${TODO_FIX} when your call ends; do not edit those files.`,
  fixNote = async (store: RunStore): Promise<readonly string[]> => {
    const state = store.current(),
      fixes = await fixItems(store.dir),
      keys = fixes.filter((item) => item.cycle === state.currentFixCycle).map((item) => item.key);
    if (state.devInput !== "qa") {
      return [];
    }
    return [
      `This round fixes what independent QA found: the recovery items ${keys.join(", ")} under "QA cycle ${state.currentFixCycle}" in ${TODO_FIX}. Fix each cause in general, re-tick the DEV items the engine unticked, and tick each FIX item off with a test that reproduces its failure.`,
    ];
  },
  workExtra = async (store: RunStore, stage: Stage): Promise<readonly string[]> => {
    if (stage === "plan") {
      return [`Do not change any project file. Write only ${TODO_DEV} and ${TODO_QA}.`];
    }
    if (stage === "wiki") {
      return [await wikiNote(store.current())];
    }
    if (stage === "dev") {
      return [tickNote(store.dir), ...(await fixNote(store))];
    }
    return [];
  },
  workParts = async (store: RunStore, call: CallSpec): Promise<CallParts> => ({
    extra: await workExtra(store, call.stage),
    read: [...stageReads(store, call.stage), ...feedbackReads(store, call)],
    write: artifactsOf(call.stage).map((name) => path.join(store.dir, name)),
  });

export { workParts };
