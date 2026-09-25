/*
 * The merged TODO lists and report, from the units': every DEV item as ticked, with its evidence;
 * every QA item unticked, to be verified again; and QA-001, the whole test suite.
 */
import { DEV_REPORT, REQUEST, TODO_DEV, TODO_QA } from "./paths.ts";
import { parseRequest, sectionOf } from "./request.ts";
import type { RequestPrefix } from "./types-todo.ts";
import type { RunStore } from "./types-store.ts";
import type { UnitEntry } from "./types-progress.ts";
import { mapAsync } from "./lists.ts";
import path from "node:path";
import { planText } from "./todo.ts";
import { readRunFile } from "./store.ts";
import { writeText } from "./files.ts";

// A part of every unit's file: which file, which section, and how to show it.
interface UnitPart {
  readonly file: string;
  readonly heading: string;
  readonly shape: (text: string) => string;
}

const asIs = (text: string): string => text,
  byUnit = async (units: readonly UnitEntry[], part: UnitPart): Promise<string> => {
    const parts = await mapAsync(units, async (unit) => {
      const body = sectionOf(await readRunFile(unit.run, part.file), part.heading).body.trim();
      return `### ${unit.id}: ${unit.title}\n\n${part.shape(body) || "- None"}`;
    });
    return parts.join("\n\n");
  },
  reportOf = async (unit: UnitEntry): Promise<string> => {
    const report = await readRunFile(unit.run, DEV_REPORT);
    return `## ${unit.id}: ${unit.title}\n\n${report.replace(/^#[^\n]*\n/u, "").trim() || "(none)"}`;
  },
  writeTodoDev = async (store: RunStore, copies: (prefixes: readonly RequestPrefix[]) => string): Promise<void> => {
    const { units } = store.current(),
      approach = await byUnit(units, { file: TODO_DEV, heading: "Approach", shape: asIs }),
      todo = await byUnit(units, { file: TODO_DEV, heading: "TODO", shape: asIs });
    await writeText(
      path.join(store.dir, TODO_DEV),
      `# Development TODO (merged)\n\nThe units' development TODO lists, merged. Each unit was built, reviewed and verified in its own worktree.\n\n## Acceptance\n${copies(["REQ"])}\n\n## Do not build\n${copies(["OUT", "LATER"])}\n\n## Cautions\n${copies(["CAUTION"])}\n\n## Approach\n${approach}\n\n## TODO\n${todo}\n\n## Open questions\n- None\n`,
    );
  },
  composeMerged = async (store: RunStore): Promise<void> => {
    const request = parseRequest(await readRunFile(store.dir, REQUEST)),
      { units } = store.current(),
      copies = (prefixes: readonly RequestPrefix[]): string => prefixes.flatMap((prefix) => request.sections[prefix].items.map((item) => item.text)).join("\n") || "- None",
      checks = await byUnit(units, { file: TODO_QA, heading: "Checks", shape: planText }),
      reports = await mapAsync(units, reportOf);
    await writeTodoDev(store, copies);
    await writeText(
      path.join(store.dir, TODO_QA),
      `# QA TODO (merged)\n\n## Checks\n- [ ] QA-001 (${request.sections.REQ.items.map((item) => item.key).join(", ")}) The project's whole test suite passes on the merged result. How: run the project's full test command. Expected: every test passes.\n\n${checks}\n`,
    );
    await writeText(path.join(store.dir, DEV_REPORT), `# Development report (merged)\n\n${reports.join("\n\n")}\n`);
  };

export { composeMerged };
