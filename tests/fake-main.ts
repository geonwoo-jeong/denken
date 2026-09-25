// The fake CLI's run: its version, a seed's re-warm, or a call played from the scenario.
import { callOf, hasRole } from "./fake-call.ts";
import type { Started } from "./fake-types.ts";
import { after } from "./fake-text.ts";
import { envText } from "./test-env.ts";
import { logRewarm } from "./fake-step.ts";
import path from "node:path";
import { play } from "./fake-play.ts";
import { readOr } from "./fake-io.ts";
import { rewarmOutput } from "./fake-output.ts";
import { text } from "node:stream/consumers";

const ARGS_START = 2,
  SCRIPT_ARG = 1,
  // Claude gets the role's instructions as an appended system prompt, and this call's facts on stdin.
  systemOf = async (args: readonly string[]): Promise<string> => {
    if (args.includes("--append-system-prompt-file")) {
      const system = await readOr(after(args, "--append-system-prompt-file"), "");
      return system;
    }
    return "";
  },
  promptOf = async (args: readonly string[]): Promise<string> => {
    const system = await systemOf(args),
      input = await text(process.stdin);
    return `${system}\n${input}`;
  },
  // A re-warm of a seed has no role in its prompt: a fork with nothing to do.
  answer = async (started: Started): Promise<void> => {
    if (hasRole(started.prompt)) {
      await play(await callOf(started));
      return;
    }
    await logRewarm(started.cli, started.scenarioPath, started.args);
    rewarmOutput(started.args, started.prompt);
  },
  runFake = async (): Promise<void> => {
    const args = process.argv.slice(ARGS_START),
      [first = ""] = args,
      cli = path.basename(process.argv.at(SCRIPT_ARG) ?? "");
    if (first === "--version") {
      process.stdout.write(`${cli} 0.0.0-fake\n`);
      return;
    }
    await answer({ args, cli, prompt: await promptOf(args), scenarioPath: envText("FAKE_SCENARIO") });
  };

export { runFake };
