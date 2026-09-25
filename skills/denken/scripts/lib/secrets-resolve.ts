// Resolving a secrets stop: accepting the findings on the user's word, or rescanning the cleaned-up record.
import { fail, stop } from "./output.ts";
import { now, oneLine } from "./text.ts";
import type { RunStore } from "./types-store.ts";
import { assertLock } from "./lock.ts";
import { hasItems } from "./lists.ts";
import { scanSecrets } from "./record-secrets.ts";
import { textFlag } from "./permission-args.ts";
import { timeline } from "./record-log.ts";

const SAID_MAX = 120,
  accept = async (store: RunStore, userSaid: string): Promise<void> => {
    const findings = store.current().secretFindings;
    if (!userSaid) {
      fail("accepting the findings needs the user's words: --accept --user-said '<verbatim>'");
    }
    store.apply({ secretsAccepted: { at: now(), findings, userSaid } });
    await timeline(store, "USER via DENKEN", `accepted ${findings.length} secret-scan finding(s) as safe: "${oneLine(userSaid, SAID_MAX)}"`);
  },
  rescan = async (store: RunStore): Promise<void> => {
    const { secretFindings } = store.apply({ secretFindings: await scanSecrets(store.current()) });
    if (hasItems(secretFindings)) {
      await assertLock();
      await store.save();
      stop("secrets_in_record", { action: "needs_user", findings: secretFindings, next: "Still found. Clean the files, then rescan, or accept with the user's words.", reason: "secrets_in_record" });
    }
    await timeline(store, "ENGINE", "secret scan: clean after the files were cleaned up");
  },
  resolve = async (store: RunStore, args: readonly string[]): Promise<void> => {
    if (args.includes("--accept")) {
      await accept(store, textFlag(args, "--user-said"));
    } else if (args.includes("--rescan")) {
      await rescan(store);
    } else {
      fail("usage: secrets <run> --rescan | --accept --user-said '<verbatim>'");
    }
  };

export { resolve };
