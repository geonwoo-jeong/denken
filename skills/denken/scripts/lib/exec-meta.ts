// A call's result as the runner writes it: from the finished run, or from a seed that broke the guard.
import type { Attempt, CallContext, ContinueStep, Outcome, Taken } from "./types-partb.ts";
import type { Meta, NoPlan, SeedMeta } from "./types-call.ts";
import { NO_PLAN } from "./meta.ts";
import { UNKNOWN } from "./call-zero.ts";
import { now } from "./text.ts";
import { patch } from "./lists.ts";
import { secondsSince } from "./exec-values.ts";

interface Finished {
  readonly attempt: Attempt;
  readonly outcome: Outcome;
  readonly taken: Taken;
  readonly violations: readonly string[];
}

interface SeedStop {
  readonly continued: ContinueStep;
  readonly seed: NoPlan | SeedMeta;
  readonly violations: readonly string[];
}

interface Undone {
  readonly error: string;
  readonly violations: readonly string[];
}

const finalMeta = (ctx: CallContext, done: Finished): Meta => ({
    continuation: done.attempt.continuation,
    denials: done.taken.denials,
    error: done.outcome.error,
    exitCode: done.taken.exitCode,
    facts: patch(done.taken.facts, { durationSec: secondsSince(ctx.startedAt), exitCode: done.taken.exitCode, sessionId: done.taken.sessionId }),
    finished: now(),
    nonce: ctx.job.nonce,
    seed: done.attempt.seed,
    sessionId: done.taken.sessionId,
    status: done.outcome.status,
    violations: done.violations,
  }),
  // A call that failed midway, after changing what it may not: a guard violation that carries the failure.
  undoneMeta = (ctx: CallContext, undone: Undone): Meta => ({
    continuation: NO_PLAN,
    denials: [],
    error: undone.error,
    exitCode: UNKNOWN,
    facts: patch(ctx.facts, { durationSec: secondsSince(ctx.startedAt), exitCode: UNKNOWN }),
    finished: now(),
    nonce: ctx.job.nonce,
    seed: NO_PLAN,
    sessionId: "",
    status: "guard_violation",
    violations: undone.violations,
  }),
  // FLAMME's seed changed what it may not: the call does not run, and the result says why.
  seedViolationMeta = (ctx: CallContext, stop: SeedStop): Meta => ({
    continuation: stop.continued.continuation,
    denials: [],
    error: "",
    exitCode: UNKNOWN,
    facts: patch(ctx.facts, { durationSec: secondsSince(ctx.startedAt), exitCode: UNKNOWN, sessionId: stop.continued.sessionId }),
    finished: now(),
    nonce: ctx.job.nonce,
    seed: stop.seed,
    sessionId: stop.continued.sessionId,
    status: "guard_violation",
    violations: stop.violations,
  });

export { finalMeta, seedViolationMeta, undoneMeta };
