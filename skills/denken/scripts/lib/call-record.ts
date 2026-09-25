// A launched call as the run records it: its slot as the call in flight, its entry in calls, and its timeline line.
import type { ActiveCall, CallRecord } from "./types-items.ts";
import { STEP, appended } from "./lists.ts";
import type { Launch } from "./types-calls.ts";
import type { RunStore } from "./types-store.ts";
import { UNKNOWN } from "./call-zero.ts";
import { agentLabel } from "./levels.ts";
import { now } from "./text.ts";
import { timeline } from "./record-log.ts";

const recordOf = (inflight: ActiveCall, model: string): CallRecord => ({
    attempt: inflight.attempt,
    denials: UNKNOWN,
    exitCode: UNKNOWN,
    finished: "",
    id: inflight.id,
    mode: inflight.mode,
    model,
    provider: inflight.provider,
    sessionId: "",
    started: inflight.started,
    status: "",
  }),
  roundText = (launch: Launch): string => {
    const { call } = launch;
    if (call.mode === "qa") {
      return `QA cycle ${call.round}`;
    }
    return `${call.stage} round ${call.round}`;
  },
  attemptText = (attempt: number): string => {
    if (attempt > STEP) {
      return `, attempt ${attempt}`;
    }
    return "";
  },
  fromText = (launch: Launch): string => {
    const plan = launch.plans.continuation;
    if (plan.kind === "continue") {
      return `, continuing its session from ${plan.from}`;
    }
    return "";
  },
  // The call in flight, its entry in calls, and its timeline line; then the state is saved.
  recordLaunch = async (store: RunStore, launch: Launch): Promise<void> => {
    const { agent } = launch.built,
      inflight: ActiveCall = Object.assign(structuredClone(launch.call), { kind: "call" as const, provider: agent.provider, started: now() });
    store.apply({ inflight });
    await timeline(store, `${launch.call.role.toUpperCase()} (${agentLabel(agent)})`, `started ${roundText(launch)}${attemptText(launch.call.attempt)}${fromText(launch)}`);
    store.apply({ calls: appended(store.current().calls, recordOf(inflight, agent.model)) });
    await store.save();
  };

export { recordLaunch };
