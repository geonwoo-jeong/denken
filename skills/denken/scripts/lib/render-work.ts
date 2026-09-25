// Markdown for the record's step files: a worker's round, with its artifacts, ticks and changes.
import { TODO_DEV, TODO_FIX } from "./paths.ts";
import { asRecord, parseJson, textOf } from "./json.ts";
import { exists, readTextOr } from "./files.ts";
import type { ActiveCall } from "./types-items.ts";
import type { Facts } from "./types-call.ts";
import type { RunStore } from "./types-store.ts";
import { artifactsOf } from "./stage-table.ts";
import path from "node:path";
import { renderFacts } from "./render-facts.ts";
import { stageChanges } from "./changes.ts";

const FIRST_ATTEMPT = 1,
  readIn = async (dir: string, file: string): Promise<string> => {
    const text = await readTextOr(path.join(dir, file), "");
    return text;
  },
  readAll = async (dir: string, files: readonly string[]): Promise<readonly string[]> => {
    const texts = await Promise.all(
      files.map(async (file) => {
        const text = await readIn(dir, file);
        return text;
      }),
    );
    return texts;
  },
  attemptNote = (attempt: number): string => {
    if (attempt > FIRST_ATTEMPT) {
      return `, attempt ${attempt}`;
    }
    return "";
  },
  artifactParts = async (store: RunStore, call: ActiveCall): Promise<readonly string[]> => {
    const texts = await readAll(store.dir, artifactsOf(call.stage));
    return artifactsOf(call.stage).flatMap((file, index) => ["", `## ${file}`, "", (texts[index] ?? "").trim() || "(empty)"]);
  },
  tickLine = (line: string): readonly string[] => {
    const parsed = parseJson(line),
      tick = asRecord(parsed.value);
    if (!parsed.ok) {
      return [];
    }
    return [`- ${textOf(tick, "item")}: \`${textOf(tick, "command")}\` exit 0 (${textOf(tick, "lastLine") || "no output"})\n  Evidence: ${textOf(tick, "evidence")}`];
  },
  fixParts = async (store: RunStore): Promise<readonly string[]> => {
    if (!(await exists(path.join(store.dir, TODO_FIX)))) {
      return [];
    }
    const text = await readIn(store.dir, TODO_FIX);
    return ["", "## todo-fix.md", "", text.trim()];
  },
  changedList = (files: readonly string[]): string => files.map((file) => `- ${file}`).join("\n") || "None.",
  devParts = async (store: RunStore, call: ActiveCall): Promise<readonly string[]> => {
    const [devText, fix, ledger, changes] = await Promise.all([
      readIn(store.dir, TODO_DEV),
      fixParts(store),
      readIn(store.dir, `calls/${call.id}.ticks.jsonl`),
      stageChanges(store.current(), "dev"),
    ]);
    return [
      "",
      "## todo-dev.md (as ticked, with evidence)",
      "",
      devText.trim(),
      ...fix,
      "",
      "## Items ticked in this round",
      "",
      ledger.split("\n").filter(Boolean).flatMap((line) => tickLine(line)).join("\n") || "None.",
      "",
      "## Files changed since development began",
      "",
      changedList(changes.changed),
    ];
  },
  stageParts = async (store: RunStore, call: ActiveCall): Promise<readonly string[]> => {
    if (call.stage === "dev") {
      const parts = await devParts(store, call);
      return parts;
    }
    if (call.stage === "wiki") {
      const changes = await stageChanges(store.current(), "wiki");
      return ["", "## Docs changed in this stage", "", changedList(changes.changed)];
    }
    return [];
  },
  renderWork = async (store: RunStore, call: ActiveCall, facts: Facts): Promise<string> => {
    const [message, artifacts, extra] = await Promise.all([readIn(store.dir, `calls/${call.id}.out.md`), artifactParts(store, call), stageParts(store, call)]),
      parts = [
        `# ${call.role.toUpperCase()} · ${call.stage} round ${call.round}${attemptNote(call.attempt)} · ${call.provider}`,
        "",
        "## Final message",
        "",
        message.trim() || "(none)",
        ...artifacts,
        ...extra,
      ];
    return `${parts.join("\n")}\n${renderFacts(facts)}`;
  };

export { renderWork };
