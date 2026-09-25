// GENAU's report in the record: one folder per QA cycle, with the evidence it saved and a table of its checks.
import type { Facts, QaItem } from "./types-call.ts";
import { STAGE_LOG, logDir, logPart } from "./record-log.ts";
import { makeDir, writeText } from "./files.ts";
import type { ActiveCall } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { copyTree } from "./record-files.ts";
import { oneLine } from "./text.ts";
import path from "node:path";
import { renderFacts } from "./render-facts.ts";

interface QaRecord {
  readonly call: ActiveCall;
  readonly facts: Facts;
  readonly items: readonly QaItem[];
}

const CELL_MAX = 300,
  cell = (text: string): string => oneLine(text, CELL_MAX).replaceAll("|", String.raw`\|`),
  filesCell = (files: readonly string[]): string => files.map((file) => `\`${path.basename(file)}\``).join(", "),
  rowOf = (item: QaItem): string =>
    `| ${item.id} | ${item.request_item} | ${item.result} | ${cell(item.check)} | ${cell(item.how_verified)} | ${cell(item.evidence)} | ${filesCell(item.evidence_files)} |`,
  resultOf = (items: readonly QaItem[]): string => {
    if (items.every((item) => item.result === "PASS")) {
      return "PASS";
    }
    return "FAIL";
  },
  reportOf = (record: QaRecord): string =>
    `# QA cycle ${record.call.round} · GENAU · ${record.call.provider}\n\nResult: **${resultOf(record.items)}**\n\n| Item | Request | Result | Check | How verified | Evidence | Files |\n| --- | --- | --- | --- | --- | --- | --- |\n${record.items.map((item) => rowOf(item)).join("\n")}\n${renderFacts(record.facts)}`,
  writeQa = async (store: RunStore, dir: string, record: QaRecord): Promise<void> => {
    const folder = path.join(dir, logPart(store.current(), STAGE_LOG.qa), `qa-${record.call.round}`);
    await makeDir(path.join(folder, "evidence"));
    await copyTree(path.join(store.dir, "calls", `${record.call.id}.evidence`), path.join(folder, "evidence"));
    await writeText(path.join(folder, "report.md"), reportOf(record));
  },
  logQa = async (store: RunStore, record: QaRecord): Promise<void> => {
    const dir = logDir(store.current());
    if (dir) {
      await writeQa(store, dir, record);
    }
  };

export { logQa };
