/*
 * The phases of one call: the guard is taken before anything runs; then the worker's session is
 * continued, or FLAMME's seed forked, or the call started fresh; then the result is concluded.
 */
import type { CallContext, ContinueStep, Guards, SeedStep } from "./types-partb.ts";
import { continueSession, startCall } from "./exec-start.ts";
import { seedChecked, takeGuards, withUndo } from "./exec-guards.ts";
import type { Meta } from "./types-call.ts";
import { NO_PLAN } from "./meta.ts";
import { concludeCall } from "./exec-conclude.ts";
import { hasItems } from "./lists.ts";
import { seedViolationMeta } from "./exec-meta.ts";

interface Continued {
  readonly continued: ContinueStep;
  readonly step: SeedStep;
}

const runStarted = async (ctx: CallContext, guards: Guards, from: Continued): Promise<Meta> => {
    const started = await startCall(ctx, from.step);
    return concludeCall(ctx, guards, { continuation: from.continued.continuation, ran: started.ran, seed: started.seed, sessionId: started.sessionId });
  },
  startFresh = async (ctx: CallContext, guards: Guards, continued: ContinueStep): Promise<Meta> => {
    const checked = await seedChecked(ctx, guards);
    if (hasItems(checked.violations)) {
      return seedViolationMeta(ctx, { continued, seed: checked.step.seed, violations: checked.violations });
    }
    return runStarted(ctx, guards, { continued, step: checked.step });
  },
  guardedCall = async (ctx: CallContext, guards: Guards): Promise<Meta> => {
    const continued = await continueSession(ctx);
    if (continued.ran.kind === "ran") {
      return concludeCall(ctx, guards, { continuation: continued.continuation, ran: continued.ran, seed: NO_PLAN, sessionId: continued.sessionId });
    }
    return startFresh(ctx, guards, continued);
  },
  runCall = async (ctx: CallContext): Promise<Meta> => {
    const guards = await takeGuards(ctx),
      meta = await withUndo(ctx, guards, async () => {
        const done = await guardedCall(ctx, guards);
        return done;
      });
    return meta;
  };

export { runCall };
