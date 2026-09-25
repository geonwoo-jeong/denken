/*
 * The tick command, run by STARK inside its own sandbox during its call: check the evidence, run the
 * item's tests, and on success record the tick in the call's ledger. The engine writes it into the
 * TODO file when the call ends.
 */
import { checkItem, citedFiles } from "./tick-evidence.ts";
import { fail, print, stop } from "./output.ts";
import { listFor, recordTick } from "./tick-record.ts";
import type { ActiveCall } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import type { TickArgs } from "./types-tick.ts";
import { now } from "./text.ts";
import path from "node:path";
import { runTest } from "./tick-run.ts";
import { tickArgs } from "./tick-args.ts";

const tickCall = (store: RunStore): ActiveCall => {
    const { inflight } = store.current();
    if (inflight.kind !== "call" || inflight.stage !== "dev" || inflight.mode !== "work") {
      return fail("tick is for STARK, during a development call");
    }
    return inflight;
  },
  tickWith = async (store: RunStore, call: ActiveCall, args: TickArgs): Promise<void> => {
    const { cited, since } = await citedFiles(store, args),
      at = now(),
      log = `${call.id}.tick-${args.item}.log`,
      run = await runTest(args.argv, path.join(store.dir, "calls", log));
    if (!run.passed) {
      stop("not_ticked", { action: "not_ticked", exitCode: run.status, item: args.item, log: path.join(store.dir, "calls", log), next: "Fix the failure, then run tick again." });
    }
    await recordTick(store.dir, call, { args, at, cited, log, run, since });
    print({ action: "ticked", item: args.item, lastLine: run.lastLine, next: `Recorded. The engine writes the tick and its evidence into ${listFor(args.item)} when this call ends. Go on to the next item.` });
  },
  cmdTick = async (store: RunStore, rawArgs: readonly string[]): Promise<void> => {
    const call = tickCall(store),
      args = tickArgs(rawArgs);
    await checkItem(store, args.item);
    await tickWith(store, call, args);
  };

export { cmdTick };
