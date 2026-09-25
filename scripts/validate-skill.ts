// One skill checked against the Agent Skills spec (https://agentskills.io/specification) and this repo's conventions.
import type { Checked, Value } from "./validate-types.ts";
import { missingLinks } from "./validate-links.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import path from "node:path";
import { readFile } from "node:fs/promises";

// A skill's frontmatter and body, checked; its errors and warnings are not yet prefixed with its file.
interface Found {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

const ROOT = path.join(import.meta.dirname, ".."),
  MAX_NAME = 64,
  MAX_DESCRIPTION = 1024,
  MAX_COMPATIBILITY = 500,
  MAX_BODY_LINES = 500,
  LINE_BASE = 1,
  NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  problemIf = (found: boolean, problem: string): readonly string[] => {
    if (found) {
      return [problem];
    }
    return [];
  },
  nameProblems = (name: Value | undefined, dirName: string): readonly string[] => {
    if (typeof name !== "string" || !name) {
      return ['missing "name"'];
    }
    return [
      ...problemIf(name.length > MAX_NAME, `"name" is ${name.length} chars (max ${MAX_NAME})`),
      ...problemIf(!NAME.test(name), `"name" must be lowercase letters, digits and single hyphens: ${name}`),
      ...problemIf(name !== dirName, `"name" (${name}) must match its directory (${dirName})`),
    ];
  },
  descriptionProblems = (description: Value | undefined): Found => {
    if (typeof description !== "string" || !description.trim()) {
      return { errors: ['missing "description"'], warnings: [] };
    }
    return {
      errors: [
        ...problemIf(description.length > MAX_DESCRIPTION, `"description" is ${description.length} chars (max ${MAX_DESCRIPTION})`),
        ...problemIf(/<\/?[a-z][^>]*>/iu.test(description), '"description" must not contain XML/HTML tags'),
      ],
      warnings: problemIf(!/\bwhen\b/iu.test(description), '"description" should say when to use the skill ("Use when ...")'),
    };
  },
  compatibilityProblems = (compatibility: Value | undefined): readonly string[] => {
    if (typeof compatibility === "string") {
      return problemIf(compatibility.length > MAX_COMPATIBILITY, `"compatibility" is ${compatibility.length} chars (max ${MAX_COMPATIBILITY})`);
    }
    return [];
  },
  placeholders = (text: string): readonly string[] =>
    text.split(/\r?\n/u).flatMap((line, index) => problemIf(line.includes("{{TODO"), `line ${index + LINE_BASE}: unfilled template placeholder`)),
  bodyWarnings = (body: string): readonly string[] => {
    const lines = body.split(/\r?\n/u).length;
    return problemIf(lines > MAX_BODY_LINES, `body is ${lines} lines; move detail into references/ (target < ${MAX_BODY_LINES})`);
  },
  nameText = (name: Value | undefined): string => {
    if (typeof name === "string") {
      return name;
    }
    return "";
  },
  checkText = async (file: string, text: string): Promise<Found & { readonly name: string }> => {
    const { body, data } = parseFrontmatter(text),
      described = descriptionProblems(data["description"]),
      { name } = data;
    return {
      errors: [
        ...nameProblems(name, path.basename(path.dirname(file))),
        ...described.errors,
        ...compatibilityProblems(data["compatibility"]),
        ...placeholders(text),
        ...(await missingLinks(file, body)),
      ],
      name: nameText(name),
      warnings: [...described.warnings, ...bodyWarnings(body)],
    };
  },
  prefixed = (file: string, found: Found & { readonly name: string }): Checked => {
    const where = path.relative(ROOT, file);
    return {
      errors: found.errors.map((problem) => `${where}: ${problem}`),
      file,
      name: found.name,
      warnings: found.warnings.map((problem) => `${where}: ${problem}`),
    };
  },
  messageOf = (error: unknown): string => {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  },
  // A frontmatter that cannot be read is the skill's only error.
  checkSkill = async (file: string): Promise<Checked> => {
    const text = await readFile(file, "utf8");
    try {
      return prefixed(file, await checkText(file, text));
    } catch (error) {
      return prefixed(file, { errors: [messageOf(error)], name: "", warnings: [] });
    }
  };

export { checkSkill, ROOT };
