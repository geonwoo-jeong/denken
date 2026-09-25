// The request-permission command: a worker or GENAU, during its call, asks DENKEN for a permission it lacks.
import { fail, print } from "./output.ts";
import type { RunStore } from "./types-store.ts";
import { appendText } from "./files.ts";
import { callBase } from "./paths.ts";
import { now } from "./text.ts";
import { textFlag } from "./permission-args.ts";
import { toLine } from "./json.ts";

const cmdRequestPermission = async (store: RunStore, args: readonly string[]): Promise<void> => {
  const { inflight } = store.current(),
    need = textFlag(args, "--need"),
    why = textFlag(args, "--why");
  if (inflight.kind !== "call" || inflight.mode === "review") {
    return fail("request-permission is for a worker or GENAU, during its call");
  }
  if (!need || !why) {
    fail('usage: request-permission <run> --need "<network | dir:<path> | tool:<pattern> | ...>" --why "<what it is for>"');
  }
  await appendText(`${callBase(store.dir, inflight.id)}.permission.jsonl`, `${toLine({ at: now(), attempt: inflight.attempt, need, why })}\n`);
  print({ action: "requested", need, next: "Stop now and end your turn with a one-line summary. DENKEN decides, then runs you again." });
};

export { cmdRequestPermission };
