// Values the _exec runner's phases share: exit codes, time units, new session ids, and why a run failed.
import type { Ran } from "./types-partb.ts";
import { oneLine } from "./text.ts";
import { randomUUID } from "node:crypto";

const SUCCESS = 0,
  MS_PER_SECOND = 1000,
  MS_PER_MINUTE = 60_000,
  // Claude takes the session id it is given; Codex makes its own, reported in its stream.
  sessionFor = (provider: string): string => {
    if (provider === "claude") {
      return randomUUID();
    }
    return "";
  },
  newSessionId = (): string => randomUUID(),
  secondsSince = (began: number): number => Math.round((Date.now() - began) / MS_PER_SECOND),
  // Why a run failed, on one line: its reported error, or else whatever it printed that was not an event.
  failureOf = (ran: Ran): string => oneLine(ran.report.error || ran.report.errorText);

export { failureOf, MS_PER_MINUTE, MS_PER_SECOND, newSessionId, secondsSince, sessionFor, SUCCESS };
