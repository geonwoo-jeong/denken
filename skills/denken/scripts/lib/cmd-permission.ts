/*
 * DENKEN's answer to a permission request (grant or deny). A grant widens what the role may do for
 * the rest of the run; either way the same call runs again, and the decision is written to rulings.md.
 */
import { checkGrant, checkNamed } from "./permission-check.ts";
import { fail, print } from "./output.ts";
import { grantOf, textFlag } from "./permission-args.ts";
import { increment, patch } from "./lists.ts";
import { keepDecision, runAgain, whatOf } from "./permission-apply.ts";
import type { Grants } from "./types-config.ts";
import type { RunStore } from "./types-store.ts";
import { assertLock } from "./lock.ts";
import { grantedDirs } from "./permission-dirs.ts";
import { recordDecision } from "./permission-record.ts";

// A decision as given on the command line.
interface Given {
  readonly args: readonly string[];
  readonly decision: string;
  readonly note: string;
  readonly userSaid: string;
}

const withRealDirs = async (grant: Grants, provider: string, userSaid: string): Promise<Grants> => {
    checkNamed(grant);
    const dirs = await grantedDirs(grant.dirs, userSaid);
    checkGrant(grant, provider, userSaid);
    return patch(grant, { dirs });
  },
  grantFor = async (given: Given, provider: string): Promise<Grants> => {
    if (given.decision !== "grant") {
      return grantOf([]);
    }
    const grant = await withRealDirs(grantOf(given.args), provider, given.userSaid);
    return grant;
  },
  checkGiven = (store: RunStore, given: Given): void => {
    const { blocked } = store.current();
    if (blocked.kind !== "permission") {
      fail("nothing to decide: the run is not waiting on a permission request");
    }
    if (!given.note) {
      fail(`${given.decision} needs --note <why>, so the worker and the record know the reason`);
    }
    if (blocked.info.userRequired === true && !given.userSaid) {
      fail(`this role has asked too often (${blocked.reason}); ask the user and pass their answer with --user-said '<verbatim>'`);
    }
  },
  actionWord = (decision: string): string => {
    if (decision === "grant") {
      return "granted";
    }
    return "denied";
  },
  decide = async (store: RunStore, given: Given): Promise<void> => {
    const { blocked, permissionDecisions } = store.current(),
      call = blocked.info.callInfo ?? fail("the permission request names no call"),
      grant = await grantFor(given, blocked.info.provider ?? ""),
      made = { call, decision: given.decision, grant, id: `P${increment(permissionDecisions.length)}`, note: given.note, userSaid: given.userSaid, what: whatOf(given.decision, grant, blocked.info.requests ?? []) };
    keepDecision(store, made);
    await assertLock();
    await recordDecision(store, made);
    runAgain(store, made);
    await store.save();
    print({ action: actionWord(given.decision), id: made.id, next: `${call.id} runs again. Run next with --wait.`, role: call.role, what: made.what });
  },
  cmdPermission = async (store: RunStore, args: readonly string[], decision: string): Promise<void> => {
    const given = { args, decision, note: textFlag(args, "--note"), userSaid: textFlag(args, "--user-said") };
    checkGiven(store, given);
    await decide(store, given);
  };

export { cmdPermission };
