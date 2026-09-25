// Whether a provider is usable: its CLI is on PATH, recent enough and logged in. An empty problem means ready.
import type { Provider, ProviderStatus, ProviderStatuses } from "./types-config.ts";
import { asRecord, parseJson, recordOf, stringsOf } from "./json.ts";
import { exists, readTextOr } from "./files.ts";
import { hasItems, isEmpty, mapAsync } from "./lists.ts";
import { ROOT } from "./paths.ts";
import { envText } from "./env.ts";
import { groupOf } from "./text.ts";
import { homedir } from "node:os";
import path from "node:path";
import { runProcess } from "./processes.ts";

const SUCCESS = 0,
  NO_PART = 0,
  PROBE_TIMEOUT_MS = 20_000,
  VERSION = /(?<version>\d+\.\d+\.\d+)/u,
  /*
   * Claude Code 2.1.271 is the first version with everything the engine relies on in its sandbox
   * settings (strictAllowlist, per-command domains in auto mode). Older versions silently ignore
   * those keys, which would leave the network open.
   */
  MIN_VERSION: Readonly<Partial<Record<Provider, string>>> = { claude: "2.1.271" },
  installed = async (provider: Provider): Promise<boolean> => {
    const dirs = envText("PATH").split(path.delimiter).filter(Boolean),
      found = await mapAsync(dirs, async (dir) => {
        const there = await exists(path.join(dir, provider));
        return there;
      });
    return found.includes(true);
  },
  // Whether a version's parts are at least the floor's, part by part.
  atLeast = (mine: readonly number[], floor: readonly number[]): boolean => {
    const [head, ...rest] = mine,
      [least, ...more] = floor;
    if (isEmpty(mine) && isEmpty(floor)) {
      return true;
    }
    if ((head ?? NO_PART) !== (least ?? NO_PART)) {
      return (head ?? NO_PART) > (least ?? NO_PART);
    }
    return atLeast(rest, more);
  },
  partsOf = (version: string): readonly number[] => version.split(".").map(Number),
  versionOf = async (provider: Provider, floor: string): Promise<string> => {
    if (!floor) {
      return "";
    }
    const result = await runProcess(provider, ["--version"], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    return groupOf(VERSION, result.stdout, "version");
  },
  versionProblem = async (provider: Provider): Promise<string> => {
    const floor = MIN_VERSION[provider] ?? "",
      version = await versionOf(provider, floor);
    if (floor && (!version || !atLeast(partsOf(version), partsOf(floor)))) {
      return `version ${version || "unknown"} is older than ${floor}`;
    }
    return "";
  },
  loginArgs = (provider: Provider): readonly string[] => {
    if (provider === "claude") {
      return ["auth", "status"];
    }
    return ["login", "status"];
  },
  // Claude's auth status is JSON; it says loggedIn false when it is not.
  loggedOut = (provider: Provider, stdout: string): boolean => provider === "claude" && asRecord(parseJson(stdout).value)["loggedIn"] === false,
  loginProblem = async (provider: Provider): Promise<string> => {
    const result = await runProcess(provider, loginArgs(provider), { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    if (result.status === SUCCESS && !loggedOut(provider, result.stdout)) {
      return "";
    }
    return "not logged in";
  },
  probe = async (provider: Provider): Promise<ProviderStatus> => {
    if (!(await installed(provider))) {
      return { problem: "not installed" };
    }
    if (envText("DENKEN_SKIP_AUTH_CHECK") === "1") {
      return { problem: "" };
    }
    const version = await versionProblem(provider);
    if (version) {
      return { problem: version };
    }
    return { problem: await loginProblem(provider) };
  },
  probeAll = async (): Promise<ProviderStatuses> => {
    const [claude, codex] = await Promise.all([probe("claude"), probe("codex")]);
    return { claude, codex };
  },
  settingsFiles = (root: string): readonly string[] => [
    path.join(envText("CLAUDE_CONFIG_DIR") || path.join(homedir(), ".claude"), "settings.json"),
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
  ],
  holeIn = async (file: string): Promise<readonly string[]> => {
    const settings = asRecord(parseJson(await readTextOr(file, "")).value),
      rules = stringsOf(recordOf(settings, "permissions"), "allow").filter((rule) => rule.startsWith("WebFetch(domain:")),
      domains = stringsOf(recordOf(recordOf(settings, "sandbox"), "network"), "allowedDomains"),
      hosts = [...rules, ...domains];
    if (hasItems(hosts)) {
      return [`${file}: ${hosts.join(", ")}`];
    }
    return [];
  },
  // Claude settings that re-open network hosts even when a role has network off.
  claudeNetworkHoles = async (root: string): Promise<readonly string[]> => {
    const holes = await mapAsync(settingsFiles(root), holeIn);
    return holes.flat();
  };

export { claudeNetworkHoles, probeAll };
