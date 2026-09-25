#!/usr/bin/env node
// Scaffold skills/<name>/SKILL.md from template/SKILL.template.md.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, ".."),
  NAME_ARG = 2,
  MAX_NAME = 64,
  FAILURE = 1,
  FIRST = 0,
  REST = 1,
  NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  exists = async (target: string): Promise<boolean> => {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  },
  titleOf = (name: string): string =>
    name
      .split("-")
      .map((word) => `${word.slice(FIRST, REST).toUpperCase()}${word.slice(REST)}`)
      .join(" "),
  refuse = (message: string): void => {
    process.stderr.write(message);
    process.exitCode = FAILURE;
  },
  scaffold = async (name: string, dir: string): Promise<void> => {
    const template = await readFile(path.join(ROOT, "template", "SKILL.template.md"), "utf8");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), template.replaceAll("{{name}}", name).replaceAll("{{title}}", titleOf(name)));
    process.stdout.write(`Created skills/${name}/SKILL.md\nFill in every {{TODO ...}}, then run: npm run validate\n`);
  },
  newSkill = async (): Promise<void> => {
    const name = process.argv.at(NAME_ARG) ?? "",
      dir = path.join(ROOT, "skills", name);
    if (!name || !NAME.test(name) || name.length > MAX_NAME) {
      refuse("Usage: npm run new -- <name>\n<name>: lowercase letters, digits and single hyphens, max 64 chars (e.g. release-notes)\n");
    } else if (await exists(dir)) {
      refuse(`skills/${name} already exists\n`);
    } else {
      await scaffold(name, dir);
    }
  };

await newSkill();
