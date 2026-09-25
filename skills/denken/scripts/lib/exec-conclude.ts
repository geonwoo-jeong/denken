/*
 * After the call: git's own files are restored before the engine runs git again, then everything
 * else the call may not change is checked and DENKEN's files restored, and the result is judged.
 */
import type { Attempt, CallContext, Guards } from "./types-partb.ts";
import type { Meta } from "./types-call.ts";
import { finalMeta } from "./exec-meta.ts";
import { guardFound } from "./exec-found.ts";
import { judge } from "./exec-judge.ts";
import { takeRun } from "./exec-take.ts";

const concludeCall = async (ctx: CallContext, guards: Guards, attempt: Attempt): Promise<Meta> => {
  const all = await guardFound(ctx, guards, { before: guards.before, guard: ctx.job.guard }),
    taken = takeRun(ctx, attempt),
    outcome = await judge(ctx, { result: attempt.ran.result, taken, violations: all });
  return finalMeta(ctx, { attempt, outcome, taken, violations: all });
};

export { concludeCall };
