/*
 * The user confirmed specific content. If request.md or a TODO list changed since, the run stops:
 * development must not run against something the user did not approve.
 */
import type { RunStore } from "./types-store.ts";
import { assertLock } from "./lock.ts";
import { block } from "./blocks.ts";
import { confirmedHashes } from "./todo.ts";
import { hasItems } from "./lists.ts";
import { logStop } from "./record-stop.ts";

const STAGES_AFTER_PLAN: ReadonlySet<string> = new Set(["dev", "qa", "wiki"]),
  scopeChanged = async (store: RunStore): Promise<boolean> => {
    const { confirmed, stage } = store.current(),
      current = await confirmedHashes(store.dir),
      changed = (["request", "todoDev", "todoQa"] as const).filter((key) => current[key] !== confirmed.hashes[key]);
    if (!confirmed.at || !STAGES_AFTER_PLAN.has(stage) || !hasItems(changed)) {
      return false;
    }
    block(store, "user", { info: { changed, resolveWith: "confirm", stage: "plan" }, reason: "scope_changed" });
    await logStop(store);
    await assertLock();
    await store.save();
    return true;
  };

export { scopeChanged };
