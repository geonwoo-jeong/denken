// A passed tick in the call's ledger (calls/<call>.ticks.jsonl): what the engine checks again when the call ends.
import { TODO_DEV, TODO_FIX, callBase } from "./paths.ts";
import { appendText, hashFile } from "./files.ts";
import type { ActiveCall } from "./types-items.ts";
import type { PassedTick } from "./types-tick.ts";
import path from "node:path";
import { shellText } from "./tick-run.ts";
import { toLine } from "./json.ts";

const PASSED = 0,
  evidenceOf = (tick: PassedTick): string => tick.args.evidence || `No change needed: ${tick.args.noChange}`,
  // The TODO file a tick is written into when the call ends.
  listFor = (item: string): string => {
    if (item.startsWith("DEV-")) {
      return TODO_DEV;
    }
    return TODO_FIX;
  },
  recordTick = async (runDir: string, call: ActiveCall, tick: PassedTick): Promise<void> => {
    const entry = {
      at: tick.at,
      cited: tick.cited,
      command: shellText(tick.args.argv),
      evidence: evidenceOf(tick),
      exitCode: PASSED,
      item: tick.args.item,
      lastLine: tick.run.lastLine,
      log: tick.log,
      logSha: await hashFile(path.join(runDir, "calls", tick.log)),
      noChange: Boolean(tick.args.noChange),
      since: tick.since,
    };
    await appendText(`${callBase(runDir, call.id)}.ticks.jsonl`, `${toLine(entry)}\n`);
  };

export { listFor, recordTick };
