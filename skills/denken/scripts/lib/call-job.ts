// A call's job.json: everything the _exec process needs to run it, taken from the run when it launches.
import { makeDir, writeText } from "./files.ts";
import type { Job } from "./types-call.ts";
import type { Launch } from "./types-calls.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { callBase } from "./paths.ts";
import { grantsOf } from "./call-grants.ts";
import { toJson } from "./json.ts";

const MS_PER_MINUTE = 60_000,
  /*
   * A unit's record lives in the parent's ai-log, outside the unit's worktree, where siblings
   * write too: the unit's guard covers its worktree, and Claude is denied the main checkout.
   */
  logOf = (state: RunState): string => {
    if (state.unit) {
      return "";
    }
    return state.log;
  },
  jobOf = async (store: RunStore, launch: Launch): Promise<Job> => {
    const state = store.current(),
      { call } = launch,
      { continuation, seed } = launch.plans,
      grants = await grantsOf(store, call);
    return Object.assign(structuredClone(call), {
      agent: Object.assign(structuredClone(launch.built.agent), grants),
      continuation,
      guard: launch.built.guard,
      log: logOf(state),
      protect: state.mainRoot,
      seed,
      stageBase: state.stageBase[call.stage],
      timeoutMs: Math.round(state.assignment.limits.callTimeoutMin * MS_PER_MINUTE),
    });
  },
  writeJob = async (store: RunStore, launch: Launch): Promise<void> => {
    const base = callBase(store.dir, launch.call.id);
    if (launch.call.mode === "qa") {
      await makeDir(`${base}.evidence`);
    }
    await writeText(`${base}.job.json`, toJson(await jobOf(store, launch)));
  };

export { writeJob };
