// The config command: show the resolved assignment, or save, change or delete a config file.
import { KEY_HELP, setKey, unsetKey, withPath } from "./config-edit.ts";
import { configPaths, resolveDetailed } from "./config-resolve.ts";
import { exists, removePath } from "./files.ts";
import type { ConfigRequest } from "./types-partc.ts";
import { EngineError } from "./engine-error.ts";
import { ROOT } from "./paths.ts";
import { fail } from "./output.ts";
import { hasItems } from "./lists.ts";
import { showConfig } from "./config-show.ts";
import { update } from "./config-save.ts";

const EXIT_FAILURE = 1,
  VALUE_AT = 2,
  initConfig = async (request: ConfigRequest): Promise<void> => {
    if (await exists(request.target)) {
      fail(`${request.target} already exists; change it with set, or start over with reset`);
    }
    const { result } = await resolveDetailed(ROOT),
      auto = { provider: "auto" },
      // In the order of the stages: the workers as resolved, the checkers left to pick the other provider.
      roles = Object.fromEntries([
        ["methode", { provider: result.stages.plan.worker.provider }],
        ["stark", { provider: result.stages.dev.worker.provider }],
        ["serie", { provider: result.stages.wiki.worker.provider }],
        ["richter", auto],
        ["ubel", auto],
        ["frieren", auto],
        ["genau", auto],
      ]);
    if (hasItems(result.errors)) {
      fail(result.errors.join("\n  "));
    }
    await update(request.target, (config) => withPath(config, ["roles"], roles));
  },
  setConfig = async (request: ConfigRequest): Promise<void> => {
    if (!request.key || !request.hasValue) {
      fail(`usage: set <key> <value>\n${KEY_HELP}`);
    }
    await update(request.target, (config) => setKey(config, request.key, request.value));
  },
  unsetConfig = async (request: ConfigRequest): Promise<void> => {
    if (!request.key) {
      fail(`usage: unset <key>\n${KEY_HELP}`);
    }
    await update(request.target, (config) => unsetKey(config, request.key));
  },
  resetConfig = async (request: ConfigRequest): Promise<void> => {
    await removePath(request.target);
    process.stdout.write(`Removed ${request.target}\n\n`);
    await showConfig(false);
  },
  showCommand = async (request: ConfigRequest): Promise<void> => {
    await showConfig(request.json);
  },
  COMMANDS: Readonly<Record<string, (request: ConfigRequest) => Promise<void>>> = {
    "": showCommand,
    init: initConfig,
    reset: resetConfig,
    set: setConfig,
    unset: unsetConfig,
  },
  targetOf = (args: readonly string[]): string => {
    const paths = configPaths(ROOT);
    if (args.includes("--global")) {
      return paths.global;
    }
    if (args.includes("--local")) {
      return paths.local;
    }
    return paths.shared;
  },
  requestOf = (args: readonly string[]): ConfigRequest => {
    const positional = args.filter((arg) => !arg.startsWith("--")),
      [command = "", key = "", value = ""] = positional;
    return { command, hasValue: positional.length > VALUE_AT, json: args.includes("--json"), key, target: targetOf(args), value };
  },
  runCommand = async (args: readonly string[]): Promise<void> => {
    const request = requestOf(args),
      command = COMMANDS[request.command];
    if (!command) {
      return fail(`unknown command "${request.command}". Use: (none) | init | set | unset | reset`);
    }
    await command(request);
  },
  // Runs the config command; an error is printed as "error: <message>" and the command exits with 1.
  configMain = async (args: readonly string[]): Promise<void> => {
    try {
      await runCommand(args);
    } catch (error) {
      if (!(error instanceof EngineError)) {
        throw error;
      }
      process.stderr.write(`error: ${error.message}\n`);
      process.exitCode = EXIT_FAILURE;
    }
  };

export { configMain };
