/*
 * The guard around one call: git's own files and a snapshot of the project and DENKEN's files,
 * taken before anything runs. A call that fails midway (its CLI would not start, a file could not
 * be read) is still undone. When the guard found anything, in the undo or in a check that ran
 * before the failure, the call ends as a guard violation carrying the failure, so the user sees it.
 */
import type { CallContext, Guards, SeedStep } from "./types-partb.ts";
import type { Guard, Meta } from "./types-call.ts";
import { foundSoFar, guardFound } from "./exec-found.ts";
import { hasItems } from "./lists.ts";
import { messageOf } from "./text.ts";
import { pinGitFiles } from "./exec-git.ts";
import { pinOwned } from "./pin.ts";
import { seedToFork } from "./exec-start.ts";
import { snapshot } from "./guard-snapshot.ts";
import { undoneMeta } from "./exec-meta.ts";

interface SeedCheck {
  readonly step: SeedStep;
  readonly violations: readonly string[];
}

// While FLAMME's seed runs, a failure is undone under the seed's guard.
let seeding = false;

// FLAMME's seed runs nothing and changes nothing, in the project or anywhere else.
const SEED_GUARD: Guard = { allow: [], frozen: true, ignored: "all" },
  takeGuards = async (ctx: CallContext): Promise<Guards> => {
    const gitPinned = await pinGitFiles(),
      before = await snapshot(ctx.runDir, ctx.job.id, ctx.job.log),
      pinned = await pinOwned(before.owned);
    return { before, gitPinned, pinned };
  },
  seedRun = async (ctx: CallContext): Promise<SeedStep> => {
    seeding = true;
    const step = await seedToFork(ctx);
    seeding = false;
    return step;
  },
  // FLAMME's seed only reads: a seed made now that changed anything is a violation, and the call does not run.
  seedChecked = async (ctx: CallContext, guards: Guards): Promise<SeedCheck> => {
    if (ctx.job.seed.kind === "none" || ctx.job.seed.sessionId) {
      const step = await seedToFork(ctx);
      return { step, violations: [] };
    }
    const before = await snapshot(ctx.runDir, ctx.job.id, ctx.job.log),
      step = await seedRun(ctx),
      found = await guardFound(ctx, guards, { before, guard: SEED_GUARD });
    return { step, violations: found.map((line) => `FLAMME's seed: ${line}`) };
  },
  guardNow = (ctx: CallContext): Guard => {
    if (seeding) {
      return SEED_GUARD;
    }
    return ctx.job.guard;
  },
  // Every line the guard found, the undo's included; the undo failing is one more.
  undoLines = async (ctx: CallContext, guards: Guards): Promise<readonly string[]> => {
    try {
      await guardFound(ctx, guards, { before: guards.before, guard: guardNow(ctx) });
      return foundSoFar();
    } catch (error) {
      return [...foundSoFar(), `undoing the call failed too: ${messageOf(error)}`];
    }
  },
  // The call's work, undone if it throws.
  withUndo = async (ctx: CallContext, guards: Guards, work: () => Promise<Meta>): Promise<Meta> => {
    try {
      return await work();
    } catch (error) {
      const undone = await undoLines(ctx, guards);
      if (!hasItems(undone)) {
        throw error;
      }
      return undoneMeta(ctx, { error: `runner error: ${messageOf(error)}`, violations: undone });
    }
  };

export { seedChecked, takeGuards, withUndo };
