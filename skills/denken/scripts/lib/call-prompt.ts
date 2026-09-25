// This call's message: who it is, where it runs, what it reads and writes, and what else it must know.
import { hasItems, onlyIf } from "./lists.ts";
import type { Agent } from "./types-config.ts";
import type { Call } from "./types-items.ts";
import type { CallParts } from "./types-calls.ts";
import { ROOT } from "./paths.ts";
import type { RunStore } from "./types-store.ts";
import { agentFor } from "./levels.ts";
import { framed } from "./text.ts";

// The message, and the agent the call runs as.
interface Prompt {
  readonly agent: Agent;
  readonly prompt: string;
}

const listed = (files: readonly string[]): string => files.map((file) => `  - ${file}`).join("\n"),
  promptOf = (store: RunStore, call: Call, parts: CallParts): Prompt => {
    const state = store.current(),
      agent = agentFor(state, call),
      lines = [
        "## This call",
        "",
        `- Role: ${call.role.toUpperCase()}`,
        `- Stage: ${call.stage}, round ${call.round}. You run on ${agent.provider}${framed(" (", agent.model, ")")}.`,
        `- Project root: ${ROOT}`,
        ...onlyIf(Boolean(state.unit), [`- Unit: ${state.unit} (${state.title}). Scope: ${state.scope.join(", ")}. This is the unit's own worktree; other units are built in parallel in theirs.`]),
        `- Run directory: ${store.dir}`,
        `- Read:\n${listed(parts.read)}`,
        ...onlyIf(hasItems(parts.write), [`- Write:\n${listed(parts.write)}`]),
        ...parts.extra.map((extra) => `- ${extra}`),
        ...onlyIf(call.mode !== "work", ["- Your final message must be JSON that matches the provided schema."]),
      ];
    return { agent, prompt: `${lines.join("\n")}\n` };
  };

export { promptOf };
