// A call's heartbeat: a file rewritten every few seconds while the call runs, so `next` can tell a live call from a dead one.
import { setTimeout as delay } from "node:timers/promises";
import { now } from "./text.ts";
import { writeText } from "./files.ts";

const BEAT_MS = 5000,
  BEAT = "beat",
  touchBeat = async (file: string): Promise<void> => {
    try {
      await writeText(file, now());
    } catch {
      // The call's directory is gone; nothing waits on this call any more.
    }
  },
  // Runs the work with the heartbeat going, and stops the heartbeat when the work ends, however it ends.
  beatWhile = async (file: string, work: () => Promise<void>): Promise<void> => {
    const stopper = new AbortController(),
      beat = async (): Promise<void> => {
        await touchBeat(file);
        try {
          await delay(BEAT_MS, BEAT, { signal: stopper.signal });
        } catch {
          return;
        }
        await beat();
      },
      beating = beat();
    try {
      await work();
    } finally {
      stopper.abort();
      await beating;
    }
  };

export { beatWhile };
