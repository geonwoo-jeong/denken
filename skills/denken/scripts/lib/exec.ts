// The _exec process: one call run to its end, its result written, and the runner's own failure recorded too.
import { failedMeta, writeMeta } from "./meta.ts";
import { beatWhile } from "./exec-heartbeat.ts";
import { callBase } from "./paths.ts";
import { jobNonce } from "./job.ts";
import { messageOf } from "./text.ts";
import { openCall } from "./exec-open.ts";
import { runCall } from "./exec-run.ts";

const execCall = async (runDir: string, id: string): Promise<void> => {
    await beatWhile(`${callBase(runDir, id)}.heartbeat`, async () => {
      const ctx = await openCall(runDir, id),
        meta = await runCall(ctx);
      await writeMeta(ctx.base, meta);
    });
  },
  // A runner that fails still leaves a result, so `next` is not left waiting on a call that is gone.
  runExec = async (runDir: string, id: string): Promise<void> => {
    try {
      await execCall(runDir, id);
    } catch (error) {
      const base = callBase(runDir, id),
        nonce = await jobNonce(base);
      await writeMeta(base, failedMeta(nonce, `runner error: ${messageOf(error)}`));
    }
  };

export { execCall, runExec };
