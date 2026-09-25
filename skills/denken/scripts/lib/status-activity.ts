// The last thing a running call did, read from the tail of its streamed log.
import { isRecord, parseJson, recordOf, recordsOf, textOf, toLine } from "./json.ts";
import type { JsonObject } from "./types-json.ts";
import { START } from "./text.ts";
import { lastOf } from "./lists.ts";
import { open } from "node:fs/promises";

// When the log last changed, and what it last showed (empty when nothing readable).
interface Activity {
  readonly last: string;
  readonly updated: string;
}

const TAIL_BYTES = 65_536,
  SHOWN_MAX = 160,
  assistantText = (event: JsonObject): string => {
    const part = lastOf(recordsOf(recordOf(event, "message"), "content").filter((content) => textOf(content, "type") === "tool_use" || textOf(content, "type") === "text"));
    if (!part) {
      return "";
    }
    if (textOf(part, "type") === "tool_use") {
      return `${textOf(part, "name")} ${toLine(part["input"] ?? {})}`;
    }
    return textOf(part, "text");
  },
  itemText = (event: JsonObject): string => {
    const item = recordOf(event, "item"),
      type = textOf(item, "type");
    if (type === "command_execution") {
      return `command: ${textOf(item, "command")}`;
    }
    if (type === "agent_message") {
      return textOf(item, "text");
    }
    return type;
  },
  describe = (line: string): string => {
    const { value } = parseJson(line);
    if (!line.startsWith("{") || !isRecord(value)) {
      return "";
    }
    if (textOf(value, "type") === "assistant") {
      return assistantText(value);
    }
    return itemText(value);
  },
  readTail = async (file: string): Promise<{ readonly text: string; readonly updated: string }> => {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat(),
        length = Math.min(info.size, TAIL_BYTES),
        { buffer } = await handle.read(Buffer.alloc(length), START, length, info.size - length);
      return { text: buffer.toString("utf8"), updated: info.mtime.toISOString() };
    } finally {
      await handle.close();
    }
  },
  lastActivity = async (file: string): Promise<Activity> => {
    try {
      const tail = await readTail(file),
        found = tail.text.split("\n").toReversed().map((line) => describe(line)).find(Boolean) ?? "";
      return { last: found.replaceAll(/\s+/gu, " ").slice(START, SHOWN_MAX), updated: tail.updated };
    } catch {
      return { last: "", updated: "" };
    }
  };

export { lastActivity };
