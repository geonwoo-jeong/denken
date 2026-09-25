/*
 * Grants are kept narrow on purpose, because the request text comes from the worker:
 *   --dir     inside the project; outside it only with the user's words, and never / or a home
 *   --domain  network access to named hosts (Claude); a wildcard, or --network for all hosts, needs the user's words
 *   --tool    Bash(<command> ...) patterns that start with a literal command (Claude only); a wildcard
 *             needs the user's words, and a shell, interpreter, network tool or git never gets one
 */
import type { Grants } from "./types-config.ts";
import { fail } from "./output.ts";
import { groupOf } from "./text.ts";
import { hasItems } from "./lists.ts";
import path from "node:path";

// An allow rule approves before auto mode's classifier looks, so a pattern for a shell, an interpreter or a network tool would be arbitrary execution.
const RUNS_ANYTHING: ReadonlySet<string> = new Set([
    "bash", "sh", "zsh", "fish", "dash", "ksh", "env", "exec", "eval", "xargs", "sudo", "su", "node", "deno", "bun", "npx", "bunx", "python", "python3", "ruby", "perl", "php", "lua", "osascript", "pwsh", "powershell", "curl", "wget", "nc", "ncat", "ssh", "scp", "rsync", "ftp", "telnet",
  ]),
  TOOL = /^Bash\((?<command>[A-Za-z0-9_./-]+)(?: [^)]*)?\)$/u,
  // A version at the end of a command's name (python3.12, node20) names the same program.
  VERSION = /[\d.]+$/u,
  programOf = (command: string): string => path.basename(command).toLowerCase().replace(VERSION, ""),
  checkTool = (tool: string, userSaid: string): void => {
    const command = groupOf(TOOL, tool, "command"),
      program = programOf(command);
    if (!command) {
      fail(`refusing tool pattern ${tool}: use Bash(<command> ...) starting with a literal command, never a bare wildcard`);
    }
    if (RUNS_ANYTHING.has(program)) {
      fail(`refusing tool pattern ${tool}: ${command} can run anything`);
    }
    // Git with free arguments runs anything too: -c core.pager=<program>, aliases, hooks.
    if (program === "git" && tool.includes("*")) {
      fail(`refusing tool pattern ${tool}: git with a wildcard can run anything; grant the exact git command instead`);
    }
    if (tool.includes("*") && !userSaid) {
      fail(`${tool} has a wildcard; ask the user and pass their answer with --user-said '<verbatim>'`);
    }
  },
  checkNamed = (grant: Grants): void => {
    if (!grant.network && !hasItems(grant.domains) && !hasItems(grant.dirs) && !hasItems(grant.tools)) {
      fail("name what to grant: --domain <host>, --dir <path>, --tool <pattern>, or --network");
    }
  },
  checkGrant = (grant: Grants, provider: string, userSaid: string): void => {
    if (grant.network && !userSaid) {
      fail("--network opens every host; prefer --domain <host>, or ask the user and pass their answer with --user-said");
    }
    if (grant.domains.some((domain) => domain.includes("*")) && !userSaid) {
      fail("a --domain with a wildcard opens many hosts; name the host, or ask the user and pass their answer with --user-said");
    }
    if (hasItems(grant.domains) && provider !== "claude") {
      fail("--domain grants apply to Claude only; Codex network access is all or nothing (--network, with --user-said)");
    }
    if (hasItems(grant.tools) && provider !== "claude") {
      fail("--tool grants apply to Claude only; Codex has no per-command allowlist");
    }
    for (const tool of grant.tools) {
      checkTool(tool, userSaid);
    }
  };

export { checkGrant, checkNamed };
