/*
 * The permissions a call launches with. Permissions DENKEN granted a role widen what it may do;
 * never a reviewer's. A granted folder counts only while it is still the folder that was granted:
 * one that is gone, unreadable, or a symlink pointing elsewhere since, is dropped, and the drop is
 * recorded so the user sees why the call runs without it.
 */
import { hasItems, mapAsync, patch } from "./lists.ts";
import type { Call } from "./types-items.ts";
import type { GrantSet } from "./types-work.ts";
import type { Grants } from "./types-config.ts";
import type { RunStore } from "./types-store.ts";
import { canonical } from "./permission-dirs.ts";
import { exists } from "./files.ts";
import { pathErrorOr } from "./fs-slot.ts";
import { timeline } from "./record-log.ts";

const NO_GRANTS: Grants = { dirs: [], domains: [], network: false, tools: [] },
  unmoved = async (dir: string): Promise<boolean> => {
    try {
      return (await exists(dir)) && (await canonical(dir)) === dir;
    } catch (error) {
      return pathErrorOr(error, false);
    }
  },
  liveDirs = async (store: RunStore, call: Call, dirs: readonly string[]): Promise<readonly string[]> => {
    const live = await mapAsync(dirs, unmoved),
      dropped = dirs.filter((_dir, index) => live[index] !== true);
    if (hasItems(dropped)) {
      await timeline(store, "DENKEN", `${call.id} runs without its grant of ${dropped.join(", ")}: no longer the folder that was granted (gone, unreadable, or pointing elsewhere)`);
    }
    return dirs.filter((_dir, index) => live[index] === true);
  },
  // The role's own grants, when it has any and is not a reviewer.
  ownGrants = (store: RunStore, call: Call): readonly Grants[] => {
    const own = store.current().grants[call.role];
    if (call.mode === "review" || !own) {
      return [];
    }
    return [own];
  },
  grantsOf = async (store: RunStore, call: Call): Promise<GrantSet> => {
    const [own] = ownGrants(store, call),
      dirs = await liveDirs(
        store,
        call,
        ownGrants(store, call).flatMap((grants) => grants.dirs),
      );
    if (!own) {
      return { granted: false, grants: NO_GRANTS };
    }
    return { granted: true, grants: patch(own, { dirs }) };
  };

export { grantsOf };
