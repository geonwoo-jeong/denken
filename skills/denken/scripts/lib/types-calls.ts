// A call being built: what its role reads, writes and is told, and the call as launched.
import type { Agent } from "./types-config.ts";
import type { Call } from "./types-items.ts";
import type { Guard } from "./types-call.ts";
import type { StartPlans } from "./types-work.ts";

// The parts of a call's prompt: files to read and write, and extra instructions.
interface CallParts {
  readonly extra: readonly string[];
  readonly read: readonly string[];
  readonly write: readonly string[];
}

// A built call: the role's instructions (system), this call's message, its guard and its agent.
interface BuiltCall {
  readonly agent: Agent;
  readonly guard: Guard;
  readonly prompt: string;
  readonly system: string;
}

// A call ready to launch: the call, its prompt and agent, and how it starts.
interface Launch {
  readonly built: BuiltCall;
  readonly call: Call;
  readonly plans: StartPlans;
}

export type { BuiltCall, CallParts, Launch };
