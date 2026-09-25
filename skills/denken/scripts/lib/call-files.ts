// The files a call starts from: its system prompt and message (fresh, forked or continued) and its seed's prompt.
import { exists, movePath, writeText } from "./files.ts";
import type { Call } from "./types-items.ts";
import type { ContinuePlan } from "./types-call.ts";
import type { Launch } from "./types-calls.ts";
import type { RunStore } from "./types-store.ts";
import { callBase } from "./paths.ts";
import { mapAsync } from "./lists.ts";
import { seedPrompt } from "./seed-prompt.ts";
import { sinceLastCall } from "./sessions.ts";


const EARLIER: readonly string[] = [".meta.json", ".pid", ".cli.pid", ".heartbeat", ".out.json", ".out.md", ".log"],
  // An earlier attempt's files are kept for debugging, out of the way of the new attempt.
  setAside = async (base: string): Promise<void> => {
    const stamp = Date.now();
    await mapAsync(EARLIER, async (suffix) => {
      if (await exists(`${base}${suffix}`)) {
        await movePath(`${base}${suffix}`, `${base}.prev-${stamp}${suffix}`);
      }
    });
  },
  checkerNote = (call: Call): string => {
    if (call.mode === "work") {
      return "";
    }
    return " FLAMME's JSON at the end of it (CONTEXT_LOADED) only marked the context as loaded; it is not a result, and says nothing about the work.";
  },
  // A forked session keeps its seed's system prompt, so a seeded call's role goes in its message.
  freshPrompt = (launch: Launch): string => {
    if (launch.plans.seed.kind === "none") {
      return launch.built.prompt;
    }
    return `${launch.built.system}\n---\n\n${launch.built.prompt}- You start from the context FLAMME loaded (above), shared by every call of your kind (worker, reviewer or QA). Files may have changed since: read a file again before relying on it.${checkerNote(launch.call)}\n`;
  },
  // A continued session already holds the role's instructions and its own earlier work.
  continuedText = async (store: RunStore, launch: Launch, plan: ContinuePlan): Promise<string> => {
    const since = await sinceLastCall(store, launch.call, plan.since),
      lines = since.map((line) => `  - ${line}`).join("\n") || "  - nothing but what is listed under Read";
    return `${launch.built.prompt}- You continue your own session from ${plan.from}: your earlier work in this stage is above. Since then:\n${lines}\n  Files may have changed: read a file again before relying on it.\n`;
  },
  continuedPrompt = async (store: RunStore, launch: Launch): Promise<string> => {
    const plan = launch.plans.continuation;
    if (plan.kind === "continue") {
      const text = await continuedText(store, launch, plan);
      return text;
    }
    return freshPrompt(launch);
  },
  writePrompts = async (store: RunStore, launch: Launch): Promise<void> => {
    const base = callBase(store.dir, launch.call.id),
      { continuation, seed } = launch.plans;
    await setAside(base);
    await writeText(`${base}.system.md`, launch.built.system);
    await writeText(`${base}.prompt.md`, await continuedPrompt(store, launch));
    if (continuation.kind === "continue") {
      await writeText(`${base}.prompt.fresh.md`, freshPrompt(launch));
    }
    if (seed.kind === "seed" && !seed.sessionId) {
      await writeText(`${base}.seed.prompt.md`, await seedPrompt(store, launch.call));
    }
  };

export { writePrompts };
