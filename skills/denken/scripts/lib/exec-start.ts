/*
 * How a call starts: a worker's later round continues its own session first; otherwise the call
 * forks FLAMME's seed for its kind (re-warmed when idle for close to the cache's hour, or made now),
 * or runs fresh. A continuation or fork that cannot start runs once more the usual way.
 */
import type { CallContext, CliHow, ContinueStep, Ran, RunSpec, SeedStep, StartStep } from "./types-partb.ts";
import type { ContinueMeta, ContinuePlan, Facts, NoPlan, SeedMeta, SeedPlan } from "./types-call.ts";
import { SUCCESS, failureOf, newSessionId, secondsSince, sessionFor } from "./exec-values.ts";
import { exists, movePath, readTextOr } from "./files.ts";
import { increment, patch } from "./lists.ts";
import { NO_FACTS } from "./call-zero.ts";
import { NO_PLAN } from "./meta.ts";
import { cliArgs } from "./cli.ts";
import { readRun } from "./exec-report.ts";
import { runCli } from "./agent-process.ts";

const START: CliHow = { forSeed: false, forkOf: "", out: "", resume: false, sessionId: "" },
  REVIEW_WARM = '{"verdict": "CONTEXT_LOADED", "summary": "Context kept warm.", "findings": [], "checked": []}',
  QA_WARM = '{"result": "CONTEXT_LOADED", "summary": "Context kept warm.", "items": []}',
  howOf = (changes: Readonly<Partial<CliHow>>): CliHow => patch(START, changes),
  runBare = async (ctx: CallContext, spec: RunSpec): Promise<Ran["result"]> => {
    const result = await runCli({ args: cliArgs(ctx.cli, spec.how), base: spec.base, env: spec.env, input: spec.input, provider: ctx.cli.provider, timeoutMs: ctx.job.timeoutMs });
    return result;
  },
  runSpec = async (ctx: CallContext, spec: RunSpec): Promise<Ran> => {
    const result = await runBare(ctx, spec),
      report = await readRun({ logPath: `${spec.base}.log`, outPath: spec.out, provider: ctx.cli.provider, structured: ctx.cli.structured });
    return { kind: "ran", report, result };
  },
  mainSpec = (ctx: CallContext, how: CliHow, input: string): RunSpec => ({ base: ctx.base, env: {}, how, input, out: ctx.cli.outPath }),
  // A run that failed before writing any final message (and did not time out) could not start.
  couldNotStart = async (ctx: CallContext, ran: Ran): Promise<boolean> =>
    !ran.result.timedOut && ran.result.status !== SUCCESS && !(await exists(ctx.cli.outPath)),
  continueFrom = async (ctx: CallContext, plan: ContinuePlan): Promise<ContinueStep> => {
    const sessionId = sessionFor(ctx.cli.provider),
      ran = await runSpec(ctx, mainSpec(ctx, howOf({ forkOf: plan.sessionId, resume: true, sessionId }), ctx.message)),
      continuation: ContinueMeta = { chain: increment(plan.chain), fallback: "", from: plan.from, kind: "continue", sessionId: plan.sessionId };
    if (await couldNotStart(ctx, ran)) {
      await movePath(`${ctx.base}.log`, `${ctx.base}.continue-failed.log`);
      return { continuation: patch(continuation, { fallback: `continuing ${plan.sessionId} failed: ${failureOf(ran)}` }), ran: NO_PLAN, sessionId };
    }
    return { continuation, ran, sessionId };
  },
  // A worker's later round continues its own session first; nothing runs here when it has none, or it cannot start.
  continueSession = async (ctx: CallContext): Promise<ContinueStep> => {
    if (ctx.job.continuation.kind === "none") {
      return { continuation: NO_PLAN, ran: NO_PLAN, sessionId: "" };
    }
    const step = await continueFrom(ctx, ctx.job.continuation);
    return step;
  },
  seedStart = (plan: SeedPlan): SeedMeta => ({ created: false, facts: NO_FACTS, fallback: "", key: plan.key, kind: "seed", rewarmed: false, sessionId: plan.sessionId }),
  warmPrompt = (ctx: CallContext): string => {
    if (!ctx.cli.structured) {
      return "Nothing to do yet. Answer exactly: READY";
    }
    if (ctx.job.mode === "review") {
      return `Nothing to do yet. Answer exactly: ${REVIEW_WARM}`;
    }
    return `Nothing to do yet. Answer exactly: ${QA_WARM}`;
  },
  /*
   * A re-warm forks the seed once with nothing to do, and that session becomes the seed. Forks of a
   * stale seed would each pay for the whole prefix again.
   */
  warmIfDue = async (ctx: CallContext, start: SeedMeta, due: boolean): Promise<SeedMeta> => {
    if (!due || !start.sessionId) {
      return start;
    }
    const warmId = newSessionId(),
      result = await runBare(ctx, { base: `${ctx.base}.rewarm`, env: ctx.cacheEnv, how: howOf({ forkOf: start.sessionId, out: `${ctx.base}.rewarm.out`, sessionId: warmId }), input: warmPrompt(ctx), out: "" });
    if (result.status === SUCCESS && !result.timedOut) {
      return patch(start, { rewarmed: true, sessionId: warmId });
    }
    return start;
  },
  seedIdOf = (ctx: CallContext, seedSession: string, ran: Ran): string => {
    if (ctx.cli.provider === "claude") {
      return seedSession;
    }
    return ran.report.sessionId;
  },
  seedFacts = (ran: Ran, began: number): Facts => patch(patch(NO_FACTS, ran.report.facts), { durationSec: secondsSince(began) }),
  settled = (start: SeedMeta, ran: Ran, seedId: string): SeedMeta => {
    if (ran.result.status === SUCCESS && !ran.result.timedOut && !ran.report.error && seedId) {
      return patch(start, { created: true, sessionId: seedId });
    }
    return patch(start, { fallback: `FLAMME could not make the seed: ${failureOf(ran)}` });
  },
  // FLAMME's seed only reads; the prompt it gets was written by the engine when it launched the call.
  makeSeed = async (ctx: CallContext, start: SeedMeta): Promise<SeedStep> => {
    const seedSession = sessionFor(ctx.cli.provider),
      began = Date.now(),
      input = await readTextOr(`${ctx.base}.seed.prompt.md`, ""),
      out = `${ctx.base}.seed.out.md`,
      ran = await runSpec(ctx, { base: `${ctx.base}.seed`, env: ctx.cacheEnv, how: howOf({ forSeed: true, out, sessionId: seedSession }), input, out }),
      seed = settled(patch(start, { facts: seedFacts(ran, began) }), ran, seedIdOf(ctx, seedSession, ran));
    return { forkOf: seed.sessionId, seed };
  },
  // The session this call forks: FLAMME's seed for its kind, re-warmed or made now; none without a seed, or when FLAMME could not make one.
  seedToFork = async (ctx: CallContext): Promise<SeedStep> => {
    if (ctx.job.seed.kind === "none") {
      return { forkOf: "", seed: NO_PLAN };
    }
    const warm = await warmIfDue(ctx, seedStart(ctx.job.seed), ctx.job.seed.rewarm);
    if (warm.sessionId) {
      return { forkOf: warm.sessionId, seed: warm };
    }
    return makeSeed(ctx, warm);
  },
  withFallback = (seed: NoPlan | SeedMeta, fallback: string): NoPlan | SeedMeta => {
    if (seed.kind === "none") {
      return seed;
    }
    return patch(seed, { fallback });
  },
  retryFresh = async (ctx: CallContext, step: SeedStep, failed: Ran): Promise<StartStep> => {
    await movePath(`${ctx.base}.log`, `${ctx.base}.fork-failed.log`);
    const sessionId = sessionFor(ctx.cli.provider),
      ran = await runSpec(ctx, mainSpec(ctx, howOf({ sessionId }), ctx.prompt));
    return { ran, seed: withFallback(step.seed, `the fork of ${step.forkOf} failed: ${failureOf(failed)}`), sessionId };
  },
  // The call itself, as a fork of its seed or fresh. A fork that cannot start (its seed gone, say) runs once more from scratch.
  startCall = async (ctx: CallContext, step: SeedStep): Promise<StartStep> => {
    const sessionId = sessionFor(ctx.cli.provider),
      ran = await runSpec(ctx, mainSpec(ctx, howOf({ forkOf: step.forkOf, sessionId }), ctx.prompt));
    if (step.forkOf && (await couldNotStart(ctx, ran))) {
      return retryFresh(ctx, step, ran);
    }
    return { ran, seed: step.seed, sessionId };
  };

export { continueSession, seedToFork, startCall };
