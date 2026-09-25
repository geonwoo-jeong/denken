// A call's permission requests, as the request-permission command wrote them (one JSON line each).
import type { PermissionDecision, PermissionRequest } from "./types-items.ts";
import { isRecord, numberOf, parseJson, textOf } from "./json.ts";
import { NONE } from "./lists.ts";
import { callBase } from "./paths.ts";
import { readTextOr } from "./files.ts";

const requestOf = (line: string): readonly PermissionRequest[] => {
    const parsed = parseJson(line);
    if (!parsed.ok || !isRecord(parsed.value)) {
      return [];
    }
    return [{ at: textOf(parsed.value, "at"), attempt: numberOf(parsed.value, "attempt", NONE), need: textOf(parsed.value, "need"), why: textOf(parsed.value, "why") }];
  },
  // The requests a call made in its current attempt.
  callRequests = async (runDir: string, id: string, attempt: number): Promise<readonly PermissionRequest[]> => {
    const text = await readTextOr(`${callBase(runDir, id)}.permission.jsonl`, "");
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => requestOf(line))
      .filter((request) => request.attempt === attempt);
  },
  // What DENKEN has already denied a role: asking for it again is denied without stopping the run.
  deniedNeeds = (decisions: readonly PermissionDecision[], role: string): readonly string[] =>
    decisions.filter((decision) => decision.role === role && decision.decision === "deny").flatMap((decision) => decision.requests.map((request) => request.need));

export { callRequests, deniedNeeds };
