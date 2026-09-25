/*
 * What the fake prints, the way each CLI streams its events: Claude an init event and a result event
 * (with usage and cost), Codex a thread.started event with the final message written to its -o file.
 */
import type { Final, Played } from "./fake-types.ts";
import type { JsonObject, JsonValue } from "./test-types.ts";
import { after, groupOf } from "./fake-text.ts";
import { at, parsed, textAt } from "./test-json.ts";
import { givenAt } from "./fake-values.ts";
import { writeTo } from "./fake-io.ts";

const INPUT_TOKENS = 100,
  OUTPUT_TOKENS = 10,
  CACHE_READ_TOKENS = 300,
  CACHE_WRITE_TOKENS = 100,
  COST_USD = 0.01,
  COMMAND = 1,
  THREAD = 2,
  printLine = (value: JsonValue): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  },
  textOf = (final: Final): string => {
    if (typeof final === "string") {
      return final;
    }
    return JSON.stringify(final);
  },
  // A structured answer goes out as structured_output too; plain text has none.
  withStructured = (event: JsonObject, final: Final): JsonObject => {
    if (typeof final === "string") {
      return event;
    }
    return Object.assign(structuredClone(event), { structured_output: final });
  },
  askedModel = (args: readonly string[]): string => {
    if (args.includes("--model")) {
      return after(args, "--model");
    }
    return "fake-default";
  },
  // The model the CLI reports it ran: the step's, else the one asked for, resolved.
  modelRan = (played: Played): string => {
    if (givenAt(played.step, "modelRan")) {
      return textAt(played.step, "modelRan");
    }
    return `${askedModel(played.call.args)}-resolved`;
  },
  denialsOf = (played: Played): JsonValue => {
    const denials = at(played.step, "denials");
    if (typeof denials === "symbol") {
      return [];
    }
    return denials;
  },
  claudeOutput = (played: Played, final: Final): void => {
    const sessionId = after(played.call.args, "--session-id"),
      usage = { cache_creation_input_tokens: CACHE_WRITE_TOKENS, cache_read_input_tokens: CACHE_READ_TOKENS, input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS };
    printLine({ model: modelRan(played), session_id: sessionId, subtype: "init", type: "system" });
    printLine(withStructured({ is_error: false, permission_denials: denialsOf(played), result: textOf(final), session_id: sessionId, total_cost_usd: COST_USD, type: "result", usage }, final));
  },
  // A resumed thread keeps its id; a new or forked one gets its own.
  threadOf = (played: Played): string => {
    const { args } = played.call;
    if (args[COMMAND] === "resume") {
      return args[THREAD] ?? "";
    }
    return `thread-${played.call.key}`;
  },
  codexOutput = async (played: Played, final: Final): Promise<void> => {
    await writeTo(after(played.call.args, "-o"), textOf(final));
    printLine({ thread_id: threadOf(played), type: "thread.started" });
  },
  output = async (played: Played, final: Final): Promise<void> => {
    if (played.call.cli === "claude") {
      claudeOutput(played, final);
      return;
    }
    await codexOutput(played, final);
  },
  // A re-warm of a seed: a fork with nothing to do, which answers exactly as its prompt says.
  rewarmOutput = (args: readonly string[], prompt: string): void => {
    const sessionId = after(args, "--session-id"),
      answer = groupOf(/Answer exactly: (?<json>\{.*\})/u, prompt, "json"),
      structured = parsed(answer),
      result = { is_error: false, permission_denials: [], result: answer || "READY", session_id: sessionId, type: "result" };
    printLine({ model: "fake-resolved", session_id: sessionId, subtype: "init", type: "system" });
    if (answer && typeof structured !== "symbol") {
      printLine(Object.assign(structuredClone(result), { structured_output: structured }));
      return;
    }
    printLine(result);
  };

export { output, rewarmOutput };
