// A checker's final message against its schema, and, for QA, against the items todo-qa.md lists.
import type { CallContext, Outcome } from "./types-partb.ts";
import { toQaOutput, validOutput } from "./outputs.ts";
import { TODO_QA } from "./paths.ts";
import { hasItems } from "./lists.ts";
import { parseItems } from "./todo.ts";
import { parseJson } from "./json.ts";
import { readRunFile } from "./store.ts";

// QA ids that todo-qa.md does not list; only a valid QA report is looked at.
const unknownItems = async (ctx: CallContext, value: unknown, valid: boolean): Promise<readonly string[]> => {
    if (!valid || ctx.job.mode !== "qa") {
      return [];
    }
    const ids = new Set(parseItems(await readRunFile(ctx.runDir, TODO_QA), "QA").items.map((item) => item.key));
    return toQaOutput(value)
      .items.filter((item) => !ids.has(item.id))
      .map((item) => item.id);
  },
  structuredOutcome = async (ctx: CallContext, output: string, error: string): Promise<Outcome> => {
    const parsed = parseJson(output),
      valid = parsed.ok && validOutput(ctx.job.mode, parsed.value),
      unknown = await unknownItems(ctx, parsed.value, valid);
    if (!valid) {
      return { error: "the final message does not match the schema", status: "invalid_output" };
    }
    if (hasItems(unknown)) {
      return { error: `the QA report has items that are not in todo-qa.md: ${unknown.join(", ")}`, status: "invalid_output" };
    }
    return { error, status: "ok" };
  };

export { structuredOutcome };
