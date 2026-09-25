/*
 * The call the fake plays, read from its command line and prompt. Scenario keys are
 * "<stage>-<role>-<round>", or "<unit>:<stage>-<role>-<round>" for a unit's calls (UNIT-1:dev-stark-1);
 * FLAMME's seeds are "<stage>-flamme-<perspective>".
 */
import type { FakeCall, Started } from "./fake-types.ts";
import { after, groupOf } from "./fake-text.ts";
import { at, parsed } from "./test-json.ts";
import path from "node:path";
import { readOr } from "./fake-io.ts";

const ROLE_HEADING = /^# (?<role>\w+):/mu,
  ROLE_LINE = /^- Role: (?<role>\w+)/mu,
  STAGE_LINE = /- Stage: (?<stage>\w+)(?:, round (?<round>\d+))?/u,
  // A continued session names its role on a line; a seed's role file starts with its heading.
  hasRole = (prompt: string): boolean => ROLE_HEADING.test(prompt) || ROLE_LINE.test(prompt),
  roleOf = (prompt: string): string => (groupOf(ROLE_HEADING, prompt, "role") || groupOf(ROLE_LINE, prompt, "role")).toLowerCase(),
  // A Codex fork sets its sandbox with -c sandbox_mode="...".
  readOnlyOf = (args: readonly string[]): boolean => args.includes("read-only") || args.includes('sandbox_mode="read-only"') || args.includes("dontAsk"),
  codexNetwork = (args: readonly string[]): string => {
    if (args.includes("sandbox_workspace_write.network_access=true")) {
      return "net";
    }
    return "nonet";
  },
  claudeNetwork = (args: readonly string[]): string => {
    if (at(parsed(after(args, "--settings")), "sandbox", "network", "strictAllowlist") === true) {
      return "nonet";
    }
    return "net";
  },
  // The log's network column: "-" read-only, "net" or "nonet" as the sandbox was set.
  networkOf = (cli: string, args: readonly string[]): string => {
    if (readOnlyOf(args)) {
      return "-";
    }
    if (cli === "codex") {
      return codexNetwork(args);
    }
    return claudeNetwork(args);
  },
  // In a unit, the file STARK works on: <first scope folder>/work.txt, or the first scope file.
  devFileOf = (unit: string, request: string): string => {
    const first = groupOf(/^- Scope: `(?<first>[^`]+)`/mu, request, "first");
    if (!unit) {
      return "src.txt";
    }
    if (first.endsWith("/")) {
      return `${first}work.txt`;
    }
    return first;
  },
  // FLAMME's seed calls name the stage and the perspective they seed, not a round.
  callIdOf = (prompt: string, seedFor: string): string => {
    const stage = groupOf(STAGE_LINE, prompt, "stage");
    if (seedFor) {
      return `${stage}-flamme-${seedFor}`;
    }
    return `${stage}-${roleOf(prompt)}-${groupOf(STAGE_LINE, prompt, "round") || "0"}`;
  },
  keyOf = (unit: string, callId: string): string => {
    if (unit) {
      return `${unit}:${callId}`;
    }
    return callId;
  },
  callOf = async (started: Started): Promise<FakeCall> => {
    const { args, cli, prompt } = started,
      seedFor = groupOf(/^- Seed for: (?<seed>\w+)/mu, prompt, "seed"),
      runDir = groupOf(/- Run directory: (?<dir>.+)/u, prompt, "dir"),
      unit = groupOf(/^- Unit: (?<unit>UNIT-\d+)/mu, prompt, "unit"),
      callId = callIdOf(prompt, seedFor),
      request = await readOr(path.join(runDir, "request.md"), "");
    return {
      args,
      callId,
      cli,
      devFile: devFileOf(unit, request),
      key: keyOf(unit, callId),
      network: networkOf(cli, args),
      prompt,
      readOnly: readOnlyOf(args),
      request,
      role: roleOf(prompt),
      round: groupOf(STAGE_LINE, prompt, "round") || "0",
      runDir,
      scenarioPath: started.scenarioPath,
      seedFor,
      stage: groupOf(STAGE_LINE, prompt, "stage"),
      unit,
    };
  };

export { callOf, hasRole };
