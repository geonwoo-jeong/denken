/*
 * The guard's check after a call (or after FLAMME's seed, or after a call that failed midway): git's
 * own files are restored first, before the engine runs git again; then the snapshot is compared and
 * DENKEN's files repaired; then, with every repair done, the evidence is written. Every line found
 * in this process is also kept, so a call that fails after its check still reports what it changed.
 */
import type { CallContext, Guards } from "./types-partb.ts";
import type { Guard } from "./types-call.ts";
import type { Snapshot } from "./types-work.ts";
import { keepEvidence } from "./evidence.ts";
import { restoreGitFiles } from "./exec-git.ts";
import { snapshot } from "./guard-snapshot.ts";
import { violations } from "./guard.ts";

// What the call is checked against: the snapshot before it, and the guard it runs under.
interface Against {
  readonly before: Snapshot;
  readonly guard: Guard;
}

let reported: readonly string[] = [];

const guardFound = async (ctx: CallContext, guards: Guards, against: Against): Promise<readonly string[]> => {
    const git = await restoreGitFiles(guards.gitPinned),
      after = await snapshot(ctx.runDir, ctx.job.id, ctx.job.log),
      found = await violations({ after, before: against.before, callId: ctx.job.id, guard: against.guard, pinned: guards.pinned, runDir: ctx.runDir }),
      kept = await keepEvidence(ctx.runDir, ctx.job.id, [...git.evidence, ...found.evidence]),
      lines = [...git.lines, ...found.lines, ...kept];
    reported = [...reported, ...lines];
    return lines;
  },
  // Every line the guard found in this process so far.
  foundSoFar = (): readonly string[] => reported;

export { foundSoFar, guardFound };
