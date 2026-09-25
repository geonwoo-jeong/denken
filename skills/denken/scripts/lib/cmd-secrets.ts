/*
 * After a secrets stop: rescan once the files are cleaned up, or accept the findings on the user's
 * word (false positives). Either way the run then finishes.
 */
import { fail, print } from "./output.ts";
import type { RunStore } from "./types-store.ts";
import { actionFor } from "./flow-actions.ts";
import { assertLock } from "./lock.ts";
import { enterStage } from "./stages.ts";
import { finish } from "./stage-approve.ts";
import { resolve } from "./secrets-resolve.ts";
import { timeline } from "./record-log.ts";

const cmdSecrets = async (store: RunStore, args: readonly string[]): Promise<void> => {
    if (store.current().blocked.reason !== "secrets_in_record") {
      fail("nothing to do: the run is not stopped on secrets in the record");
    }
    await resolve(store, args);
    store.apply({ blocked: { info: {}, kind: "none", reason: "", since: "" } });
    await timeline(store, "ENGINE", "DONE: every stage approved");
    await finish(store);
    await enterStage(store, "done");
    await assertLock();
    await store.save();
    print(await actionFor(store));
  };

export { cmdSecrets };
