// Launching the next call: its prompt and job are written, the run records it, and _exec runs it as a separate process.
import type { RunStore } from "./types-store.ts";
import { assertLock } from "./lock.ts";
import { buildCall } from "./call-build.ts";
import { continueFor } from "./sessions.ts";
import { nextCall } from "./call-next.ts";
import { recordLaunch } from "./call-record.ts";
import { seedFor } from "./seeds.ts";
import { spawnExec } from "./call-spawn.ts";
import { writeJob } from "./call-job.ts";
import { writePrompts } from "./call-files.ts";

const launch = async (store: RunStore): Promise<void> => {
  const call = nextCall(store),
    built = await buildCall(store, call),
    seed = await seedFor(store, call, built.agent),
    plan = { built, call, plans: { continuation: continueFor(store.current(), call, built.agent), seed } };
  await writePrompts(store, plan);
  await writeJob(store, plan);
  await recordLaunch(store, plan);
  await assertLock();
  await spawnExec(store.dir, call.id);
};

export { launch };
