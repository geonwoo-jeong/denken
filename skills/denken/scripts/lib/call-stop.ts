// Stopping a running call: its agent CLI's process group, and the _exec process that runs it.
import { pidAlive, signalGroup } from "./processes.ts";
import type { Provider } from "./types-config.ts";
import { readTextOr } from "./files.ts";
import { stopCallGroup } from "./agent-group.ts";

const stopCall = async (base: string, provider: Provider): Promise<void> => {
    const pid = Number(await readTextOr(`${base}.pid`, "0"));
    await stopCallGroup(base, provider);
    if (pid && pidAlive(pid)) {
      signalGroup(pid, "SIGTERM");
    }
  };

export { stopCall };
