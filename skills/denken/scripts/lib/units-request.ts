/*
 * A unit's request.md: the request narrowed to the unit's REQ items, with everything that bounds
 * it (out of scope, not now, cautions) and a Unit section: its scope, its numbers, and the units
 * built beside it.
 */
import { parseRequest, sectionOf } from "./request.ts";
import { ID_BLOCK } from "./units-child.ts";
import { REQUEST } from "./paths.ts";
import type { RequestPrefix } from "./types-todo.ts";
import { STEP } from "./lists.ts";
import type { UnitPlan } from "./types-units.ts";
import { groupsOf } from "./text.ts";
import { readRunFile } from "./store.ts";

const HEADING = /^#\s+(?:Request:\s*)?(?<title>.*)$/mu,
  taskOf = (text: string): string => {
    const { title } = groupsOf(HEADING, text);
    if (typeof title === "string") {
      return title.trim();
    }
    return "task";
  },
  scopeText = (scope: readonly string[]): string => scope.map((entry) => `\`${entry}\``).join(", "),
  decisionsOf = (text: string): readonly string[] => {
    const decisions = sectionOf(text, "Decisions").body.trim();
    if (decisions) {
      return ["", "## Decisions", decisions];
    }
    return [];
  },
  firstNumber = (unit: UnitPlan): number => unit.num * ID_BLOCK + STEP,
  unitSection = (unit: UnitPlan, units: readonly UnitPlan[]): readonly string[] => [
    "## Unit",
    `- ${unit.id}: ${unit.title}.`,
    `- Scope: ${scopeText(unit.scope)}. Change files only there: a change anywhere else goes back to STARK. If an item cannot be done inside the scope, say so under Open questions, and DENKEN will change the split.`,
    `- Number this unit's items from ${firstNumber(unit)}: DEV-${firstNumber(unit)}, QA-${firstNumber(unit)}, and so on.`,
    "- Built by other units at the same time, not by this one:",
    ...units.filter((other) => other.id !== unit.id).map((other) => `  - ${other.id} (${other.reqs.join(", ")}) ${other.title}. Scope: ${scopeText(other.scope)}.`),
  ],
  unitRequest = async (runDir: string, unit: UnitPlan, units: readonly UnitPlan[]): Promise<string> => {
    const text = await readRunFile(runDir, REQUEST),
      request = parseRequest(text),
      list = (prefix: RequestPrefix): string => request.sections[prefix].items.map((item) => item.text).join("\n") || "- None";
    return [
      `# Request: ${taskOf(text)} · ${unit.id}: ${unit.title}`,
      "",
      "## Goal",
      request.goal.trim(),
      "",
      `This run builds ${unit.id} of that goal, "${unit.title}", while other units are built at the same time.`,
      "",
      "## Confirmed",
      request.sections.REQ.items
        .filter((item) => unit.reqs.includes(item.key))
        .map((item) => item.text)
        .join("\n"),
      "",
      "## Out of scope",
      list("OUT"),
      "",
      "## Not now",
      list("LATER"),
      "",
      "## Cautions",
      list("CAUTION"),
      "",
      ...unitSection(unit, units),
      ...decisionsOf(text),
      "",
    ].join("\n");
  };

export { unitRequest };
