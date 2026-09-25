/*
 * A unit's TODO lists, written from its request.md the way METHODE would: every item copied, one DEV
 * and one QA item per REQ item, numbered from the unit's first number.
 */
import { FIRST_NUMBER, itemsOf } from "./fake-plan.ts";
import { MISSING, at, listAt } from "./test-json.ts";
import type { Plan, Played } from "./fake-types.ts";
import { groupOf, pad } from "./fake-text.ts";

const REQ_KEY = /(?<req>REQ-\d{3,})/u,
  // The files the DEV items name: the step's devFiles, else the unit's own file.
  filesOf = (played: Played): string => {
    const named = listAt(played.step, "devFiles").filter((file): file is string => typeof file === "string");
    if (at(played.step, "devFiles") === MISSING) {
      return `\`${played.call.devFile}\``;
    }
    return named.map((file) => `\`${file}\``).join(", ");
  },
  devTodo = (request: string, devFile: string, items: readonly string[]): string =>
    `# Development TODO\n\n## Acceptance\n${itemsOf(request, "Confirmed", "REQ").join("\n")}\n\n## Do not build\n${[...itemsOf(request, "Out of scope", "OUT"), ...itemsOf(request, "Not now", "LATER")].join("\n")}\n\n## Cautions\n${itemsOf(request, "Cautions", "CAUTION").join("\n")}\n\n## Approach\nBuild it in ${devFile}.\n\n## TODO\n${items.join("\n")}\n\n## Open questions\n- None\n`,
  planFromRequest = (played: Played): Plan => {
    const { devFile, request } = played.call,
      first = Number(groupOf(/Number this unit's items from (?<first>\d+)/u, request, "first") || FIRST_NUMBER),
      keys = itemsOf(request, "Confirmed", "REQ").map((line) => groupOf(REQ_KEY, line, "req")),
      files = filesOf(played),
      dev = keys.map((key, index) => `- [ ] DEV-${pad(first + index)} (${key}) build ${key}. Files: ${files}.`),
      checks = keys.map((key, index) => `- [ ] QA-${pad(first + index)} (${key}) check ${key}`);
    return { dev: devTodo(request, devFile, dev), qa: `# QA TODO\n\n## Checks\n${checks.join("\n")}\n` };
  };

export { planFromRequest };
