#!/usr/bin/env node
// Scaffold skills/<name>/SKILL.md from template/SKILL.template.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];

if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
  console.error("Usage: npm run new -- <name>");
  console.error("<name>: lowercase letters, digits and single hyphens, max 64 chars (e.g. release-notes)");
  process.exit(1);
}

const dir = join(root, "skills", name);
if (existsSync(dir)) {
  console.error(`skills/${name} already exists`);
  process.exit(1);
}

const title = name
  .split("-")
  .map((word) => word[0].toUpperCase() + word.slice(1))
  .join(" ");
const content = readFileSync(join(root, "template", "SKILL.template.md"), "utf8")
  .replaceAll("{{name}}", name)
  .replaceAll("{{title}}", title);

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "SKILL.md"), content);

console.log(`Created skills/${name}/SKILL.md`);
console.log("Fill in every {{TODO ...}}, then run: npm run validate");
