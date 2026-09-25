/*
 * The units.md file: DENKEN's optional split of the request into units that are built at the same time:
 *   - UNIT-1 (REQ-001, REQ-002) <title>. Scope: `src/a/`, `test/a/`.
 * Each unit gets its own git worktree and runs plan, dev (with review) and QA there; when every
 * unit is done, the engine merges them and verifies the whole again. Work whose scope or
 * dependencies overlap is not split: it belongs in one unit, where its items run in order.
 */
import { LEVELS, isLevel } from "./config-defaults.ts";
import { REQUEST, UNITS } from "./paths.ts";
import { STEP, entriesOf, isEmpty, onlyIf } from "./lists.ts";
import type { UnitLine, UnitPlan, UnitsCheck } from "./types-units.ts";
import { allGroups, groupOf, groupsOf } from "./text.ts";
import { isChecker, rolesOf } from "./levels.ts";
import { parseRequest, requestProblems } from "./request.ts";
import type { Level } from "./types-config.ts";
import path from "node:path";
import { readRunFile } from "./store.ts";

interface LevelCheck {
  readonly levels: Readonly<Record<string, Level>>;
  readonly problems: readonly string[];
}

const MAX_UNITS = 9,
  MIN_UNITS = 2,
  UNIT_LINE = /^\s*[-*]\s*[*_`]*(?<id>UNIT-(?<num>\d+))\b[*_`]*\s*\((?<refs>[^)]*)\)\s*(?<rest>.*)$/u,
  BAD_SCOPE = /^\/|(?:^|\/)\.\.(?:\/|$)|[*?[\]{}]/u,
  partOf = (rest: string, label: string): string =>
    groupOf(new RegExp(String.raw`\b${label}:\s*(?<value>.*?)(?=\b(?:Scope|Levels?):|$)`, "iu"), rest, "value"),
  pairsOf = (text: string): readonly (readonly [string, string])[] => {
    const pairs: (readonly [string, string])[] = [];
    for (const match of text.matchAll(/(?<key>[a-z]+)=(?<value>[a-z]+)/gu)) {
      const groups = match.groups ?? {};
      pairs.push([groups["key"] ?? "", groups["value"] ?? ""]);
    }
    return pairs;
  },
  titleOf = (rest: string): string => {
    const [title = ""] = rest.split(/\b(?:Scope|Levels?):/iu);
    return title.trim().replace(/[.\s]+$/u, "");
  },
  unitOf = (line: string): readonly UnitLine[] => {
    const groups = groupsOf(UNIT_LINE, line),
      id = groups["id"] ?? "",
      rest = groups["rest"] ?? "";
    if (!id) {
      return [];
    }
    return [
      {
        id,
        levelPairs: pairsOf(partOf(rest, "Levels?")),
        num: Number(groups["num"]),
        reqs: (groups["refs"] ?? "").match(/\bREQ-\d{3,}\b/gu) ?? [],
        scope: allGroups(/`(?<entry>[^`]+)`/gu, partOf(rest, "Scope"), "entry").map((entry) => entry.trim()),
        title: titleOf(rest),
      },
    ];
  },
  parseUnits = (text: string): readonly UnitLine[] => text.split("\n").flatMap((line) => unitOf(line)),
  // A scope entry is a directory ("src/a/", or a name without an extension) or a file.
  scopeDir = (entry: string): boolean => entry.endsWith("/") || !/\.\w+$/u.test(path.basename(entry)),
  inScope = (scope: readonly string[], file: string): boolean =>
    scope.some((entry) => {
      if (scopeDir(entry)) {
        return file.startsWith(`${entry.replace(/\/$/u, "")}/`);
      }
      return file === entry;
    }),
  overlapName = (one: string, two: string): string => {
    if (one === two) {
      return one;
    }
    return `${one} and ${two}`;
  },
  scopesOverlap = (first: string, second: string): boolean => {
    const one = first.replace(/\/$/u, ""),
      two = second.replace(/\/$/u, "");
    return one === two || two.startsWith(`${one}/`) || one.startsWith(`${two}/`);
  },
  levelLine = (unit: UnitLine, pair: readonly [string, string]): LevelCheck => {
    const [key, value] = pair,
      roles = rolesOf(key);
    if (isEmpty(roles) || !isLevel(value)) {
      return { levels: {}, problems: [`${unit.id}: "${key}=${value}" is not a level; use <stage or role>=<${LEVELS.join("|")}>`] };
    }
    if (value === "light" && roles.every((role) => isChecker(role))) {
      return { levels: {}, problems: [`${unit.id}: ${key} checks other work, and a checker never runs below standard`] };
    }
    return { levels: Object.fromEntries(roles.filter((role) => !(value === "light" && isChecker(role))).map((role) => [role, value])), problems: [] };
  },
  // The levels a unit's line gives its roles; later pairs win, as they are read in order.
  unitLevels = (unit: UnitLine): LevelCheck => {
    const checks = unit.levelPairs.map((pair) => levelLine(unit, pair));
    return { levels: Object.fromEntries(checks.flatMap((check) => entriesOf(check.levels))), problems: checks.flatMap((check) => check.problems) };
  },
  unitProblems = (unit: UnitLine, index: number, reqs: readonly string[]): readonly string[] => [
    ...onlyIf(unit.num !== index + STEP, [`number the units in order from UNIT-1 (found ${unit.id} in place ${index + STEP})`]),
    ...onlyIf(isEmpty(unit.reqs), [`${unit.id} names no REQ items`]),
    ...onlyIf(!unit.title, [`${unit.id} needs a title`]),
    ...onlyIf(isEmpty(unit.scope), [`${unit.id} needs a scope: the paths it may change, as \`src/a/\`, \`test/a/\``]),
    ...unit.scope.filter((entry) => BAD_SCOPE.test(entry) || !entry.trim()).map((entry) => `${unit.id}: scope "${entry}" must be a plain path inside the project, without globs`),
    ...unit.reqs.filter((req) => !reqs.includes(req)).map((req) => `${unit.id} names ${req}, which request.md does not define`),
  ],

  ownerProblems = (units: readonly UnitLine[], reqs: readonly string[]): readonly string[] =>
    reqs.flatMap((req) => {
      const owners = units.filter((unit) => unit.reqs.includes(req)).map((unit) => unit.id);
      if (isEmpty(owners)) {
        return [`${req} is in no unit`];
      }
      return onlyIf(owners.length !== STEP, [`${req} is in ${owners.join(" and ")}; each REQ item belongs to exactly one unit`]);
    }),
  pairOverlaps = (first: UnitLine, second: UnitLine): readonly string[] =>
    first.scope.flatMap((one) =>
      second.scope
        .filter((two) => scopesOverlap(one, two))
        .map((two) => `${first.id} and ${second.id} overlap at ${overlapName(one, two)}: work whose scope overlaps is not split. Put it in one unit, where its items run in order`),
    ),
  overlapProblems = (units: readonly UnitLine[]): readonly string[] =>
    units.flatMap((first, index) => units.slice(index + STEP).flatMap((second) => pairOverlaps(first, second))),
  withLevels = (unit: UnitLine): UnitPlan => Object.assign(structuredClone(unit), { levels: unitLevels(unit).levels }),
  // The split in units.md, checked against the request: its units, and every problem with it.
  unitsProblems = async (runDir: string): Promise<UnitsCheck> => {
    const lines = parseUnits(await readRunFile(runDir, UNITS)),
      reqs = parseRequest(await readRunFile(runDir, REQUEST)).sections.REQ.items.map((item) => item.key),
      units = lines.map((line) => withLevels(line));
    if (lines.length < MIN_UNITS) {
      return { problems: [`${UNITS} needs at least two units to split the work; without it, the request runs as one`], units };
    }
    return {
      problems: [
        ...onlyIf(lines.length > MAX_UNITS, [`${UNITS} has ${lines.length} units; at most ${MAX_UNITS}`]),
        ...lines.flatMap((line, index) => [...unitProblems(line, index, reqs), ...unitLevels(line).problems]),
        ...ownerProblems(lines, reqs),
        ...overlapProblems(lines),
      ],
      units,
    };
  },
  // A new split's check: request.md's problems first, then units.md's.
  splitCheck = async (runDir: string): Promise<UnitsCheck> => {
    const check = await unitsProblems(runDir),
      request = requestProblems(await readRunFile(runDir, REQUEST));
    return { problems: [...request, ...check.problems], units: check.units };
  };

export { inScope, MAX_UNITS, parseUnits, scopeDir, scopesOverlap, splitCheck, unitsProblems };
