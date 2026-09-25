// The commands that change a run, each holding the run's lock while it works.
import type { RunStore } from "./types-store.ts";
import { cmdConfirm } from "./cmd-confirm.ts";
import { cmdLevels } from "./cmd-levels.ts";
import { cmdPermission } from "./cmd-permission.ts";
import { cmdRetry } from "./cmd-retry.ts";
import { cmdRule } from "./cmd-rule.ts";
import { cmdSecrets } from "./cmd-secrets.ts";
import { cmdStart } from "./cmd-start.ts";

type Command = (store: RunStore, args: readonly string[]) => Promise<void>;

const LOCKED: Readonly<Record<string, Command>> = {
  confirm: cmdConfirm,
  deny: async (store, args) => {
    await cmdPermission(store, args, "deny");
  },
  grant: async (store, args) => {
    await cmdPermission(store, args, "grant");
  },
  levels: cmdLevels,
  retry: async (store) => {
    await cmdRetry(store);
  },
  rule: cmdRule,
  secrets: cmdSecrets,
  start: cmdStart,
};

export { LOCKED };
