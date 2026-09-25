// A ruling on a block: checked against where the run stands, recorded, applied, and saved.
import { checkRuling, stageOf } from "./rule-checks.ts";
import type { RuleRequest } from "./types-rule.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { applyRuling } from "./rule-apply.ts";
import { assertLock } from "./lock.ts";
import { print } from "./output.ts";
import { recordRuling } from "./rule-record.ts";
import { timeline } from "./record-log.ts";
import { valueOf } from "./rule-args.ts";

// A decision DENKEN gave, and the note that explains it.
interface Decided {
  readonly decision: string;
  readonly note: string;
}

const targetsOf = (state: RunState, args: readonly string[]): readonly string[] => {
    const identity = state.blocked.info.identity ?? "",
      named = valueOf(args, "--identities")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    return [...new Set([identity, ...named].filter(Boolean))];
  },
  printRuled = async (store: RunStore, decision: string, id: string): Promise<void> => {
    const { stage } = store.current();
    if (stage === "aborted") {
      await timeline(store, "RESUME", "the run was aborted");
      print({ action: "ruled", decision, id, next: "Tell the user the run was aborted.", stage });
      return;
    }
    await timeline(store, "RESUME", `the run continues in ${stage}`);
    print({ action: "ruled", decision, id, next: "Run next with --wait.", stage });
  },
  ruleOn = async (store: RunStore, request: RuleRequest): Promise<void> => {
    await checkRuling(store, request);
    await assertLock();
    const ruled = await recordRuling(store, request);
    await applyRuling(store, request, ruled);
    await assertLock();
    await store.save();
    await printRuled(store, request.decision, ruled.id);
  },
  ruleOnBlock = async (store: RunStore, decided: Decided, args: readonly string[]): Promise<void> => {
    const state = store.current();
    await ruleOn(store, { blocked: state.blocked, decision: decided.decision, note: decided.note, stage: stageOf(state), targets: targetsOf(state, args) });
  };

export { ruleOnBlock };
