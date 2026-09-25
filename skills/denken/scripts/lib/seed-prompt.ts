// The prompt FLAMME makes a seed with: its role file, then what this seed is for and what to read.
import { PERSPECTIVE, seedInputs } from "./seeds.ts";
import { ROOT, SKILL_DIR } from "./paths.ts";
import { exists, readText } from "./files.ts";
import type { CallSpec } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { hasItems } from "./lists.ts";
import path from "node:path";

const SEED_USE: Readonly<Record<string, string>> = {
    qa: "GENAU, who verifies the product independently",
    reviewer: "the reviewers who check plans, code and docs against the request (RICHTER, UBEL, FRIEREN)",
    worker: "the workers who plan, build and document (METHODE, STARK, SERIE)",
  },
  // What a checker's seed answers with: its schema's shape, marked as only loading the context.
  ANSWER: Readonly<Record<string, string>> = {
    qa: `{"result": "CONTEXT_LOADED", "summary": "QA context loaded.", "items": []}`,
    review: `{"verdict": "CONTEXT_LOADED", "summary": "Reviewer context loaded.", "findings": [], "checked": [<the files you read>]}`,
  },
  readLine = (runDir: string, inputs: readonly string[]): string => {
    if (hasItems(inputs)) {
      return `- Read:\n${inputs.map((file) => `  - ${path.join(runDir, file)}`).join("\n")}`;
    }
    return "- Read: nothing from the run yet; the project itself";
  },
  answerLines = (mode: CallSpec["mode"]): readonly string[] => {
    const answer = ANSWER[mode];
    if (typeof answer === "string") {
      return [`- This call answers in JSON; end with exactly: ${answer}`];
    }
    return [];
  },
  existing = async (runDir: string, files: readonly string[]): Promise<readonly string[]> => {
    const found = await Promise.all(
      files.map(async (file) => {
        const there = await exists(path.join(runDir, file));
        return there;
      }),
    );
    return files.filter((_file, index) => found[index] === true);
  },
  seedPrompt = async (store: RunStore, call: CallSpec): Promise<string> => {
    const perspective = PERSPECTIVE[call.mode],
      role = await readText(path.join(SKILL_DIR, "roles", "flamme.md")),
      inputs = await existing(store.dir, seedInputs(perspective, call.stage));
    return [
      role.trimEnd(),
      "",
      "---",
      "",
      "## This seed",
      "",
      `- Stage: ${call.stage}`,
      `- Seed for: ${perspective}. Used by ${SEED_USE[perspective] ?? ""}.`,
      `- Project root: ${ROOT}`,
      `- Run directory: ${store.dir}`,
      readLine(store.dir, inputs),
      ...answerLines(call.mode),
      "",
    ].join("\n");
  };

export { seedPrompt };
