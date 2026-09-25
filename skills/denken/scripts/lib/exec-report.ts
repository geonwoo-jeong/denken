/*
 * What a CLI run reported, read from its streamed log: its session, the final message (written to
 * the output file), denials, errors, and the facts of the run (model that ran, cost, tokens). Lines
 * that are not JSON events are the CLI's own errors.
 */
import type { JsonObject, JsonValue } from "./types-json.ts";
import { NONE, lastOf, patch, sum } from "./lists.ts";
import { NO_TOKENS, UNKNOWN } from "./call-zero.ts";
import type { RunFacts, RunReport, RunTarget } from "./types-partb.ts";
import { hasKey, isRecord, numberOf, parseJson, recordOf, recordsOf, textOf, toJson, toLine } from "./json.ts";
import { readTextOr, writeText } from "./files.ts";
import type { Tokens } from "./types-call.ts";

// A run's final message, when it gave one.
interface Final {
  readonly present: boolean;
  readonly text: string;
}

interface Stream {
  readonly events: readonly JsonObject[];
  readonly noise: string;
}

const NO_OUTPUT: Final = { present: false, text: "" },
  NO_RUN_FACTS: RunFacts = { costUsd: UNKNOWN, modelRan: "", tokens: NO_TOKENS, turns: UNKNOWN },
  eventOf = (line: string): readonly JsonObject[] => {
    const parsed = parseJson(line);
    if (parsed.ok && isRecord(parsed.value)) {
      return [parsed.value];
    }
    return [];
  },
  streamOf = (text: string): Stream => {
    const lines = text.split("\n");
    return {
      events: lines.filter((line) => line.startsWith("{")).flatMap((line) => eventOf(line)),
      noise: lines
        .filter((line) => !line.startsWith("{") && line.trim() !== "")
        .map((line) => `${line}\n`)
        .join(""),
    };
  },
  typed = (events: readonly JsonObject[], type: string): readonly JsonObject[] => events.filter((event) => textOf(event, "type") === type),
  // A value as the CLI's text shows it: null or missing as nothing.
  shown = (value: JsonValue | undefined): string => {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (isRecord(value)) {
      return toLine(value);
    }
    return "";
  },
  claudeTokens = (final: JsonObject): Tokens => {
    if (!isRecord(final["usage"])) {
      return NO_TOKENS;
    }
    const usage = recordOf(final, "usage");
    return {
      cacheRead: numberOf(usage, "cache_read_input_tokens", UNKNOWN),
      cacheWrite: numberOf(usage, "cache_creation_input_tokens", UNKNOWN),
      input: numberOf(usage, "input_tokens", UNKNOWN),
      output: numberOf(usage, "output_tokens", UNKNOWN),
    };
  },
  structuredOutput = (final: JsonObject): Final => {
    if (!hasKey(final, "structured_output") || final["structured_output"] === null) {
      return NO_OUTPUT;
    }
    return { present: true, text: toJson(final["structured_output"]) };
  },
  textOutput = (final: JsonObject): Final => {
    if (!hasKey(final, "result") || final["result"] === null) {
      return NO_OUTPUT;
    }
    return { present: true, text: shown(final["result"]) };
  },
  // The final message: the structured output for a checker, the result text for a worker.
  finalOutput = (final: JsonObject, structured: boolean): Final => {
    if (structured) {
      return structuredOutput(final);
    }
    return textOutput(final);
  },
  claudeError = (final: JsonObject): string => {
    if (final["is_error"] !== true) {
      return "";
    }
    return `claude reported an error: ${shown(final["subtype"])} ${shown(final["api_error_status"])}`.trim();
  },
  claudeErrorText = (final: JsonObject): string => {
    if (final["is_error"] !== true) {
      return "";
    }
    return `${shown(final["result"])} ${shown(final["api_error_status"])}\n`;
  },
  // The model that actually ran: an alias or an allowlist can differ from what was asked for.
  claudeReport = (stream: Stream, final: JsonObject | undefined): RunReport => {
    const init = stream.events.find((event) => textOf(event, "type") === "system" && textOf(event, "subtype") === "init") ?? {},
      modelRan = textOf(init, "model"),
      sessionId = textOf(init, "session_id");
    if (!final) {
      return { denials: [], error: "", errorText: stream.noise, facts: patch(NO_RUN_FACTS, { modelRan }), sessionId };
    }
    return {
      denials: recordsOf(final, "permission_denials").map((denial) => ({ input: denial["tool_input"] ?? "", tool: textOf(denial, "tool_name") })),
      error: claudeError(final),
      errorText: `${stream.noise}${claudeErrorText(final)}`,
      facts: { costUsd: numberOf(final, "total_cost_usd", UNKNOWN), modelRan, tokens: claudeTokens(final), turns: numberOf(final, "num_turns", UNKNOWN) },
      sessionId,
    };
  },
  codexTokens = (usages: readonly JsonObject[]): Tokens => {
    if (usages.length === NONE) {
      return NO_TOKENS;
    }
    return {
      cacheRead: sum(usages.map((usage) => numberOf(usage, "cached_input_tokens", NONE))),
      cacheWrite: UNKNOWN,
      input: sum(usages.map((usage) => numberOf(usage, "input_tokens", NONE))),
      output: sum(usages.map((usage) => numberOf(usage, "output_tokens", NONE))),
    };
  },
  codexReport = (stream: Stream): RunReport => {
    const started = lastOf(typed(stream.events, "thread.started")) ?? {},
      usages = typed(stream.events, "turn.completed").filter((event) => isRecord(event["usage"])).map((event) => recordOf(event, "usage")),
      failures = stream.events.filter((event) => textOf(event, "type") === "error" || textOf(event, "type") === "turn.failed");
    return {
      denials: [],
      error: "",
      errorText: `${stream.noise}${failures.map((event) => `${toLine(event)}\n`).join("")}`,
      facts: patch(NO_RUN_FACTS, { tokens: codexTokens(usages) }),
      sessionId: textOf(started, "thread_id"),
    };
  },
  writeOutput = async (target: RunTarget, final: JsonObject | undefined): Promise<void> => {
    if (!final) {
      return;
    }
    const output = finalOutput(final, target.structured);
    if (output.present) {
      await writeText(target.outPath, output.text);
    }
  },
  // Claude's final message is written to the output file here; Codex writes its own (-o).
  readRun = async (target: RunTarget): Promise<RunReport> => {
    const stream = streamOf(await readTextOr(target.logPath, "")),
      final = lastOf(typed(stream.events, "result"));
    if (target.provider === "codex") {
      return codexReport(stream);
    }
    await writeOutput(target, final);
    return claudeReport(stream, final);
  };

export { readRun };
