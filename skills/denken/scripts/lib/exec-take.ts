// What a call's run reported, taken into its result: its session, error, denials and facts.
import type { Attempt, CallContext, Taken } from "./types-partb.ts";
import type { ContinueMeta, NoPlan, SeedMeta } from "./types-call.ts";
import { MS_PER_MINUTE } from "./exec-values.ts";
import { patch } from "./lists.ts";

const continuedText = (continuation: ContinueMeta | NoPlan): string => {
    if (continuation.kind === "none") {
      return "";
    }
    if (continuation.fallback) {
      return `not continued: ${continuation.fallback}`;
    }
    return `continued the session of ${continuation.from} (round ${continuation.chain} in it)`;
  },
  seedText = (seed: NoPlan | SeedMeta): string => {
    if (seed.kind === "none") {
      return "";
    }
    if (seed.fallback) {
      return `not used: ${seed.fallback}`;
    }
    if (seed.created) {
      return `forked from FLAMME's seed ${seed.sessionId}, made for this call`;
    }
    return `forked from FLAMME's seed ${seed.sessionId}`;
  },
  // A timeout wins over a spawn error, which wins over what the CLI reported.
  runError = (ctx: CallContext, attempt: Attempt): string => {
    const { report, result } = attempt.ran;
    if (result.timedOut) {
      return `timed out after ${Math.round(ctx.job.timeoutMs / MS_PER_MINUTE)} min`;
    }
    return result.error || report.error;
  },
  // Claude's session is the one the engine gave it; Codex's is the one it reported.
  sessionOf = (ctx: CallContext, attempt: Attempt): string => {
    if (ctx.cli.provider === "codex") {
      return attempt.ran.report.sessionId;
    }
    return attempt.sessionId;
  },
  takeRun = (ctx: CallContext, attempt: Attempt): Taken => {
    const { report, result } = attempt.ran;
    return {
      denials: report.denials,
      error: runError(ctx, attempt),
      errorText: report.errorText,
      exitCode: result.status,
      facts: patch(patch(ctx.facts, report.facts), { continued: continuedText(attempt.continuation), seed: seedText(attempt.seed) }),
      sessionId: sessionOf(ctx, attempt),
    };
  };

export { takeRun };
