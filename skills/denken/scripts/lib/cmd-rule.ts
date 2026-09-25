// The rule command: DENKEN's decision on a block, recorded and applied; on the whole split while units work.
import { decisionOf, noteOf } from "./rule-args.ts";
import type { RunStore } from "./types-store.ts";
import { fail } from "./output.ts";
import { ruleOnBlock } from "./rule-on.ts";
import { ruleUnits } from "./parallel-rule.ts";

const cmdRule = async (store: RunStore, args: readonly string[]): Promise<void> => {
  if (store.current().blocked.kind === "none" && store.current().stage !== "units") {
    fail("nothing to rule on: the run is not blocked");
  }
  const decision = decisionOf(args),
    note = await noteOf(args);
  if (store.current().stage === "units") {
    await ruleUnits(store, { decision, note });
    return;
  }
  await ruleOnBlock(store, { decision, note }, args);
};

export { cmdRule };
