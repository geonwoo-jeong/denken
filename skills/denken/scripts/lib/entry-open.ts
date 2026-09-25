// The commands that only read a run, or that an agent runs during its call: they take no lock.
import type { RunStore } from "./types-store.ts";
import { cmdRequestPermission } from "./cmd-request.ts";
import { cmdStatus } from "./cmd-status.ts";
import { cmdTick } from "./cmd-tick.ts";

type Command = (store: RunStore, args: readonly string[]) => Promise<void>;

const OPEN: Readonly<Record<string, Command>> = {
  "request-permission": cmdRequestPermission,
  status: async (store) => {
    await cmdStatus(store);
  },
  tick: cmdTick,
};

export { OPEN };
