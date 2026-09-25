// A finished call in the run's list of calls, and in the timeline when it did not end well.
import { framed, now, oneLine } from "./text.ts";
import { hasItems, mapAsync, patch, withLast } from "./lists.ts";
import type { ActiveCall } from "./types-items.ts";
import type { Meta } from "./types-call.ts";
import type { RunStore } from "./types-store.ts";
import { artifactsOf } from "./stage-table.ts";
import { exists } from "./files.ts";
import path from "node:path";
import { timeline } from "./record-log.ts";

const presentIn =
    (dir: string) =>
    async (name: string): Promise<boolean> => {
      const found = await exists(path.join(dir, name));
      return found;
    },
  missingArtifacts = async (store: RunStore, call: ActiveCall): Promise<readonly string[]> => {
    const names = artifactsOf(call.stage),
      present = await mapAsync(names, presentIn(store.dir));
    return names.filter((_name, index) => present[index] !== true);
  },
  // A worker that wrote none of its report failed, whatever its CLI said.
  checkedMeta = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<Meta> => {
    if (call.mode !== "work" || meta.status !== "ok") {
      return meta;
    }
    const missing = await missingArtifacts(store, call);
    if (hasItems(missing)) {
      return patch(meta, { error: `${missing.join(", ")} was not written`, status: "failed" });
    }
    return meta;
  },
  recordResult = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<void> => {
    const changes = { denials: meta.denials.length, exitCode: meta.exitCode, finished: meta.finished || now(), sessionId: meta.sessionId, status: meta.status };
    store.apply({ calls: withLast(store.current().calls, (record) => record.id === call.id, (record) => patch(record, changes)) });
    if (meta.status !== "ok") {
      await timeline(store, call.role.toUpperCase(), `${meta.status}${framed(": ", oneLine(meta.error), "")}${framed(": ", meta.violations.join("; "), "")}`);
    }
  };

export { checkedMeta, recordResult };
