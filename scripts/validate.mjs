#!/usr/bin/env node
// Validate every skill under skills/ against the Agent Skills spec
// (https://agentskills.io/specification) plus this repo's conventions.
// Zero dependencies: the frontmatter parser covers the YAML subset skills use.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "skills");
const MAX_BODY_LINES = 500;

const errors = [];
const warnings = [];
const rel = (p) => relative(root, p);

// A SKILL.md shadows anything nested below it, matching the skills CLI.
function findSkillFiles(dir) {
  if (!existsSync(dir)) return [];
  const own = join(dir, "SKILL.md");
  if (existsSync(own)) return [own];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .flatMap((e) => findSkillFiles(join(dir, e.name)));
}

// SKILL.md files outside skills/ get published when skills/ is empty (CLI fallback scan)
// or when installing with --full-depth. Dot-directories hold installed skills and are skipped.
function findStraySkillFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isFile() && e.name === "SKILL.md") return [path];
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") return [];
    if (path === skillsDir) return [];
    return findStraySkillFiles(path);
  });
}

function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("missing YAML frontmatter delimited by --- lines");
  const lines = match[1].split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    if (!kv) throw new Error(`frontmatter line ${i + 2} is not "key: value": ${line}`);
    const key = kv[1];
    const raw = (kv[2] ?? "").trim();
    if (/^[|>][+-]?$/.test(raw)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      data[key] = block.join(raw[0] === "|" ? "\n" : " ").trim();
    } else if (raw === "") {
      const nested = {};
      while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) {
        const entry = lines[++i].trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (entry) nested[entry[1]] = unquote(entry[2]);
      }
      data[key] = nested;
    } else {
      const quoted = /^["']/.test(raw);
      if (!quoted && (/:\s/.test(raw) || /\s#/.test(raw) || /^[[{&*!%@`]/.test(raw))) {
        throw new Error(`"${key}" contains YAML syntax characters; wrap the value in double quotes`);
      }
      data[key] = unquote(raw);
    }
  }
  return { data, body: text.slice(match[0].length) };
}

function checkLinks(file, body, report) {
  const text = body.replace(/^```[\s\S]*?^```/gm, "");
  const targets = [
    ...[...text.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/`((?:references|scripts|assets)\/[^`\s]+)`/g)].map((m) => m[1]),
  ];
  for (const target of targets) {
    if (/^[a-z]+:/i.test(target) || target.startsWith("#") || /[<{*]/.test(target)) continue;
    const path = join(dirname(file), decodeURI(target.split("#")[0]));
    if (!existsSync(path)) report(`links to missing file: ${target}`);
  }
}

function validateSkill(file) {
  const dirName = basename(dirname(file));
  const err = (msg) => errors.push(`${rel(file)}: ${msg}`);
  const warn = (msg) => warnings.push(`${rel(file)}: ${msg}`);
  const text = readFileSync(file, "utf8");

  let data, body;
  try {
    ({ data, body } = parseFrontmatter(text));
  } catch (e) {
    return err(e.message);
  }

  const { name, description, compatibility } = data;
  if (typeof name !== "string" || !name) err('missing "name"');
  else {
    if (name.length > 64) err(`"name" is ${name.length} chars (max 64)`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) err(`"name" must be lowercase letters, digits and single hyphens: ${name}`);
    if (name !== dirName) err(`"name" (${name}) must match its directory (${dirName})`);
  }

  if (typeof description !== "string" || !description.trim()) err('missing "description"');
  else {
    if (description.length > 1024) err(`"description" is ${description.length} chars (max 1024)`);
    if (/<\/?[a-z][^>]*>/i.test(description)) err('"description" must not contain XML/HTML tags');
    if (!/\bwhen\b/i.test(description)) warn('"description" should say when to use the skill ("Use when ...")');
  }

  if (typeof compatibility === "string" && compatibility.length > 500) {
    err(`"compatibility" is ${compatibility.length} chars (max 500)`);
  }

  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes("{{TODO")) err(`line ${i + 1}: unfilled template placeholder`);
  });

  const bodyLines = body.split(/\r?\n/).length;
  if (bodyLines > MAX_BODY_LINES) {
    warn(`body is ${bodyLines} lines; move detail into references/ (target < ${MAX_BODY_LINES})`);
  }

  checkLinks(file, body, err);
  return name;
}

const skillFiles = findSkillFiles(skillsDir);
const seen = new Map();
for (const file of skillFiles) {
  const name = validateSkill(file);
  if (typeof name !== "string") continue;
  if (seen.has(name)) errors.push(`${rel(file)}: duplicate name "${name}" (also ${rel(seen.get(name))})`);
  else seen.set(name, file);
}

for (const file of findStraySkillFiles(root)) {
  errors.push(`${rel(file)}: SKILL.md outside skills/ would be published by the CLI; move it under skills/ or rename it`);
}

for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);

if (skillFiles.length === 0 && errors.length === 0) {
  console.log("No skills yet. Create one with: npm run new -- <name>");
} else if (errors.length > 0) {
  console.error(`\n${errors.length} error(s) in ${skillFiles.length} skill(s)`);
  process.exit(1);
} else {
  console.log(`${skillFiles.length} skill(s) valid${warnings.length ? `, ${warnings.length} warning(s)` : ""}`);
}
