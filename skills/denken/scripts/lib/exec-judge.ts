/*
 * The verdict on a call: a guard violation, a timeout, a usage limit, a failure, or a final message
 * that must also match its schema (and, for QA, list only the items in todo-qa.md).
 */
import type { CallContext, Judged, Outcome } from "./types-partb.ts";
import { NO_STATUS } from "./processes.ts";
import { SUCCESS } from "./exec-values.ts";
import { USAGE_LIMIT } from "./stage-table.ts";
import { hasItems } from "./lists.ts";
import { readTextOr } from "./files.ts";
import { structuredOutcome } from "./exec-schema.ts";

const statusText = (status: number): string => {
    if (status === NO_STATUS) {
      return "null";
    }
    return String(status);
  },
  failedStatus = (errorText: string): string => {
    if (USAGE_LIMIT.test(errorText)) {
      return "usage_limit";
    }
    return "failed";
  },
  failedRun = (ctx: CallContext, judged: Judged): Outcome => ({
    error: judged.taken.error || `${ctx.cli.provider} exited with ${statusText(judged.result.status)}`,
    status: failedStatus(judged.taken.errorText),
  }),
  // The verdict before the final message is looked at: a violation, a timeout, or a failed run.
  runOutcome = (ctx: CallContext, judged: Judged): Outcome => {
    const { error } = judged.taken;
    if (hasItems(judged.violations)) {
      return { error, status: "guard_violation" };
    }
    if (judged.result.timedOut) {
      return { error, status: "timeout" };
    }
    if (judged.result.status !== SUCCESS || error) {
      return failedRun(ctx, judged);
    }
    return { error, status: "ok" };
  },
  judge = async (ctx: CallContext, judged: Judged): Promise<Outcome> => {
    const outcome = runOutcome(ctx, judged),
      text = await readTextOr(ctx.cli.outPath, ""),
      output = text.trim();
    if (outcome.status !== "ok") {
      return outcome;
    }
    if (!output) {
      return { error: "the agent produced no final message", status: "failed" };
    }
    if (ctx.cli.structured) {
      return structuredOutcome(ctx, output, outcome.error);
    }
    return outcome;
  };

export { judge };
