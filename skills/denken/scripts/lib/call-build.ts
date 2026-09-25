// A call as launched: its prompt (the role's cacheable instructions, and this call's message), guard and agent.
import type { BuiltCall } from "./types-calls.ts";
import type { Call } from "./types-items.ts";
import type { Guard } from "./types-call.ts";
import type { RunStore } from "./types-store.ts";
import { SKILL_DIR } from "./paths.ts";
import { artifactsOf } from "./stage-table.ts";
import { callParts } from "./call-parts.ts";
import path from "node:path";
import { promptOf } from "./call-prompt.ts";
import { readText } from "./files.ts";

const ignoredOf = (call: Call, frozen: boolean): Guard["ignored"] => {
    if (call.mode === "qa") {
      return "env";
    }
    if (frozen) {
      return "all";
    }
    return "none";
  },
  // Reviewers, GENAU and the planner may not change the project; workers write only their reports among DENKEN's files.
  guardOf = (call: Call): Guard => {
    const frozen = call.mode !== "work" || call.stage === "plan";
    if (call.mode === "work") {
      return { allow: artifactsOf(call.stage), frozen, ignored: ignoredOf(call, frozen) };
    }
    return { allow: [], frozen, ignored: ignoredOf(call, frozen) };
  },
  roleFile = async (name: string): Promise<string> => {
    const text = await readText(path.join(SKILL_DIR, "roles", `${name}.md`));
    return text.trimEnd();
  },
  // A reviewer's instructions are its stage checklist followed by the rules every reviewer shares.
  roleText = async (call: Call): Promise<string> => {
    const own = await roleFile(call.role);
    if (call.mode === "review") {
      return `${own}\n\n${await roleFile("reviewer")}`;
    }
    return own;
  },
  buildCall = async (store: RunStore, call: Call): Promise<BuiltCall> => {
    const parts = await callParts(store, call),
      built = promptOf(store, call, parts),
      system = await roleText(call);
    return { agent: built.agent, guard: guardOf(call), prompt: built.prompt, system: `${system.trimEnd()}\n` };
  };

export { buildCall };
