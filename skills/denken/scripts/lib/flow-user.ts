// What DENKEN is shown when the run waits on the user: which command resolves it.
import type { Action } from "./types-flow.ts";
import type { RunState } from "./types-run.ts";
import { shownWith } from "./flow-view.ts";

const sameModelNext = (role: string): string =>
    `${role.toUpperCase()} ran as the same model as the work it checks. Change it with levels <run> ${role}=<level> (or --model ${role}=<id> / --effort ${role}=<value>) --note '<why>', or ask the user to change it in config.ts; then run retry. retry refuses while it would run the same way.`,
  otherNext = (state: RunState): string => {
    if (state.blocked.info.resolveWith === "rule") {
      return "Ask the user, then record their decision with rule.";
    }
    return "Tell the user. When it is resolved, run retry (or rule --decision abort).";
  },
  userAction = (state: RunState): Action => {
    const { blocked } = state;
    if (blocked.reason === "same_model_ran") {
      return shownWith(blocked, { action: "needs_user", next: sameModelNext(blocked.info.role ?? "") });
    }
    if (blocked.reason === "secrets_in_record") {
      return shownWith(blocked, {
        action: "needs_user",
        next: "Show the user each file and line (not the value). Remove or redact the secret in the record, then run secrets --rescan; if they are false positives, run secrets --accept --user-said '<their words>'.",
      });
    }
    return shownWith(blocked, { action: "needs_user", next: otherNext(state) });
  };

export { userAction };
