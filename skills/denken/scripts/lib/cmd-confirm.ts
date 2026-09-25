// The confirm command: the user approved the scope and both TODO lists; development starts against exactly that content.
import { fail, print } from "./output.ts";
import type { RunStore } from "./types-store.ts";
import { applyConfirmation } from "./confirm-apply.ts";
import { assertLock } from "./lock.ts";
import { checkConfirmable } from "./confirm-checks.ts";
import { confirmUnits } from "./parallel-confirm.ts";
import { recordConfirmed } from "./confirm-record.ts";
import { valueOf } from "./rule-args.ts";

const confirmRun = async (store: RunStore, userSaid: string): Promise<void> => {
    await checkConfirmable(store);
    await applyConfirmation(store, userSaid);
    await recordConfirmed(store, userSaid);
    await assertLock();
    await store.save();
    print({ action: "confirmed", next: "Development starts. Run next with --wait." });
  },
  cmdConfirm = async (store: RunStore, args: readonly string[]): Promise<void> => {
    const userSaid = valueOf(args, "--user-said").trim();
    if (!userSaid) {
      fail("record the user's approval: confirm <run> --user-said '<what they said, verbatim>'");
    }
    if (store.current().stage === "units") {
      await confirmUnits(store, userSaid);
      return;
    }
    await confirmRun(store, userSaid);
  };

export { cmdConfirm };
