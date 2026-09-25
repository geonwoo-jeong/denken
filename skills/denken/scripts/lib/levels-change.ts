// A change of levels mid-run: checked like the ones start takes, and described role by role.
import { agentLabel, choiceProblems, roleAgents } from "./levels.ts";
import { entriesOf, hasItems, patch } from "./lists.ts";
import type { Agent } from "./types-config.ts";
import type { RunStore } from "./types-store.ts";
import { fail } from "./output.ts";
import { parseChoices } from "./level-choices.ts";

const changesOf = (before: Readonly<Record<string, Agent>>, after: Readonly<Record<string, Agent>>): readonly string[] =>
    entriesOf(after).flatMap(([role, agent]) => {
      const was = agentLabel(before[role] ?? agent),
        now = agentLabel(agent);
      if (was === now) {
        return [];
      }
      return [`${role.toUpperCase()} ${was} → ${now}`];
    }),
  choose = (store: RunStore, args: readonly string[]): readonly string[] => {
    const state = store.current(),
      before = roleAgents(state),
      next = parseChoices(args, { levels: state.levels, overrides: state.overrides }),
      problems = choiceProblems(patch(state, next));
    if (hasItems(problems)) {
      fail(problems.join("; "));
    }
    store.apply(next);
    return changesOf(before, roleAgents(store.current()));
  };

export { choose };
