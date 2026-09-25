#!/usr/bin/env node
/*
 * Validate every skill under skills/ against the Agent Skills spec
 * (https://agentskills.io/specification) plus this repo's conventions.
 * Zero dependencies: the frontmatter parser covers the YAML subset skills use.
 */
import { ROOT, checkSkill } from "./validate-skill.ts";
import { findSkillFiles, findStraySkillFiles } from "./validate-find.ts";
import type { Checked } from "./validate-types.ts";
import path from "node:path";

// What the whole check found: the skills, and every error and warning, in order.
interface Report {
  readonly errors: readonly string[];
  readonly skills: number;
  readonly warnings: readonly string[];
}

const SKILLS_DIR = path.join(ROOT, "skills"),
  FAILURE = 1,
  START = 0,
  NONE = 0,
  rel = (file: string): string => path.relative(ROOT, file),
  // A skill whose name an earlier skill already has: the error names the earlier one.
  duplicateOf = (earlier: readonly Checked[], skill: Checked): readonly string[] => {
    const first = earlier.find((other) => other.name === skill.name);
    if (!skill.name || !first) {
      return [];
    }
    return [`${rel(skill.file)}: duplicate name "${skill.name}" (also ${rel(first.file)})`];
  },
  reportOf = async (): Promise<Report> => {
    const files = await findSkillFiles(SKILLS_DIR),
      checked = await Promise.all(
        files.map(async (file) => {
          const skill = await checkSkill(file);
          return skill;
        }),
      ),
      strays = await findStraySkillFiles(ROOT, SKILLS_DIR);
    return {
      errors: [
        ...checked.flatMap((skill, index) => [...skill.errors, ...duplicateOf(checked.slice(START, index), skill)]),
        ...strays.map((file) => `${rel(file)}: SKILL.md outside skills/ would be published by the CLI; move it under skills/ or rename it`),
      ],
      skills: files.length,
      warnings: checked.flatMap((skill) => skill.warnings),
    };
  },
  warningsNote = (report: Report): string => {
    if (report.warnings.length > NONE) {
      return `, ${report.warnings.length} warning(s)`;
    }
    return "";
  },
  summarize = (report: Report): void => {
    if (report.skills === NONE && report.errors.length === NONE) {
      process.stdout.write("No skills yet. Create one with: npm run new -- <name>\n");
    } else if (report.errors.length > NONE) {
      process.stderr.write(`\n${report.errors.length} error(s) in ${report.skills} skill(s)\n`);
      process.exitCode = FAILURE;
    } else {
      process.stdout.write(`${report.skills} skill(s) valid${warningsNote(report)}\n`);
    }
  },
  validate = async (): Promise<void> => {
    const report = await reportOf();
    for (const warning of report.warnings) {
      process.stderr.write(`warn  ${warning}\n`);
    }
    for (const error of report.errors) {
      process.stderr.write(`error ${error}\n`);
    }
    summarize(report);
  };

await validate();
