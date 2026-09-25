/*
 * The agent CLIs' command lines. Claude and Codex differ in how a call starts (fresh, as FLAMME's
 * seed, forking a seed, continuing a session), in how its sandbox is set, and in what they cache,
 * so each has its own builder. Both stream JSON events, which go straight to the call's log so
 * `status` can show progress.
 */
import type { CliContext, CliHow } from "./types-partb.ts";
import { framed } from "./text.ts";
import { hasItems } from "./lists.ts";
import { toLine } from "./json.ts";

const CLAUDE_HEAD: readonly string[] = ["-p", "--output-format", "stream-json", "--verbose", "--session-id"],
  PROTECTED_TOOLS: readonly string[] = ["Edit", "Write", "NotebookEdit"],
  forkArgs = (how: CliHow): readonly string[] => {
    if (how.forkOf) {
      return ["--resume", how.forkOf, "--fork-session"];
    }
    return [];
  },
  // A seeded call's role text is in its message and its flags are exactly the seed's, so a fork reads the seed from the cache.
  systemArgs = (ctx: CliContext): readonly string[] => {
    if (!ctx.seeded && ctx.system) {
      return ["--append-system-prompt-file", `${ctx.base}.system.md`];
    }
    return [];
  },
  /*
   * Moving cwd and git status out of the system prompt keeps it the same across directories
   * (units' worktrees) and for every fork of a seed.
   */
  dynamicArgs = (ctx: CliContext): readonly string[] => {
    if (ctx.seeded || (ctx.system && ctx.protect)) {
      return ["--exclude-dynamic-system-prompt-sections"];
    }
    return [];
  },
  /*
   * Reviewers and GENAU check other agents' work, so they load no project settings (a worker
   * could have planted hooks there) and no MCP servers.
   */
  checkerArgs = (ctx: CliContext): readonly string[] => {
    if (ctx.mode === "work") {
      return [];
    }
    return ["--setting-sources", "user", "--strict-mcp-config"];
  },
  /*
   * The strict allowlist covers sandboxed commands only; web tools and MCP servers reach the
   * network in-process, so they are removed too.
   */
  offlineArgs = (ctx: CliContext): readonly string[] => {
    if (ctx.network) {
      return [];
    }
    if (ctx.mode === "work") {
      return ["--disallowedTools", "WebFetch,WebSearch", "--strict-mcp-config"];
    }
    return ["--disallowedTools", "WebFetch,WebSearch"];
  },
  sandboxOf = (ctx: CliContext): object => {
    if (ctx.network) {
      return { allowUnsandboxedCommands: false, enabled: true, failIfUnavailable: true };
    }
    return { allowUnsandboxedCommands: false, enabled: true, failIfUnavailable: true, network: { allowedDomains: ctx.grants.domains, strictAllowlist: true } };
  },
  /*
   * Hooks belong to someone's interactive sessions; in DENKEN's calls they would only add context
   * the role must not rely on. The sandbox bounds Bash; Claude's own file tools are bounded by
   * permission rules. A unit's agents may not edit the main checkout, which holds the other
   * units' record. "//" makes the rule path absolute; a single "/" would be relative to the
   * settings source.
   */
  settingsOf = (ctx: CliContext): string => {
    if (ctx.protect) {
      return toLine({ disableAllHooks: true, permissions: { deny: PROTECTED_TOOLS.map((tool) => `${tool}(/${ctx.protect}/**)`) }, sandbox: sandboxOf(ctx) });
    }
    return toLine({ disableAllHooks: true, sandbox: sandboxOf(ctx) });
  },
  grantArgs = (ctx: CliContext): readonly string[] => {
    const dirs = ctx.grants.dirs.flatMap((dir) => ["--add-dir", dir]);
    if (hasItems(ctx.grants.tools)) {
      return [...dirs, "--allowedTools", ctx.grants.tools.join(",")];
    }
    return dirs;
  },
  toolArgs = (ctx: CliContext): readonly string[] => {
    if (ctx.mode === "review") {
      return ["--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--settings", toLine({ disableAllHooks: true })];
    }
    return ["--permission-mode", "auto", ...offlineArgs(ctx), "--settings", settingsOf(ctx), ...grantArgs(ctx)];
  },
  schemaArgs = (ctx: CliContext): readonly string[] => {
    if (ctx.structured) {
      return ["--json-schema", ctx.schemaText];
    }
    return [];
  },
  optionArgs = (flag: string, value: string): readonly string[] => {
    if (value) {
      return [flag, value];
    }
    return [];
  },
  claudeArgs = (ctx: CliContext, how: CliHow): readonly string[] => [
    ...CLAUDE_HEAD,
    how.sessionId,
    ...forkArgs(how),
    ...systemArgs(ctx),
    ...dynamicArgs(ctx),
    ...checkerArgs(ctx),
    ...toolArgs(ctx),
    ...schemaArgs(ctx),
    ...optionArgs("--model", ctx.model),
    ...optionArgs("--effort", ctx.effort),
  ],
  // A Codex seed only reads.
  codexMode = (ctx: CliContext, how: CliHow): string => {
    if (how.forSeed || ctx.mode === "review") {
      return "read-only";
    }
    return "workspace-write";
  },
  // Codex continues a worker's session in place (exec resume), which keeps its cache.
  resumeWord = (how: CliHow): string => {
    if (how.resume) {
      return "resume";
    }
    return "fork";
  },
  // A fork takes its sandbox from -c, and would otherwise keep the seed's, so every fork sets it.
  codexHead = (ctx: CliContext, how: CliHow): readonly string[] => {
    const mode = codexMode(ctx, how),
      out = how.out || ctx.outPath;
    if (how.forkOf) {
      return ["exec", resumeWord(how), how.forkOf, "--json", "-c", `sandbox_mode="${mode}"`, "-o", out];
    }
    return ["exec", "--json", "-s", mode, "-o", out];
  },
  networkArgs = (ctx: CliContext): readonly string[] => {
    if (ctx.network) {
      return ["-c", "sandbox_workspace_write.network_access=true"];
    }
    return [];
  },
  writableArgs = (ctx: CliContext, how: CliHow): readonly string[] => {
    if (!hasItems(ctx.grants.dirs)) {
      return [];
    }
    if (how.forkOf) {
      return ["-c", `sandbox_workspace_write.writable_roots=${toLine(ctx.grants.dirs)}`];
    }
    return ctx.grants.dirs.flatMap((dir) => ["--add-dir", dir]);
  },
  codexWriteArgs = (ctx: CliContext, how: CliHow): readonly string[] => {
    if (how.forSeed || ctx.mode === "review") {
      return [];
    }
    return [...networkArgs(ctx), ...writableArgs(ctx, how)];
  },
  codexSchemaArgs = (ctx: CliContext, how: CliHow): readonly string[] => {
    if (ctx.structured && !how.forSeed) {
      return ["--output-schema", ctx.schemaPath];
    }
    return [];
  },
  codexArgs = (ctx: CliContext, how: CliHow): readonly string[] => [
    ...codexHead(ctx, how),
    ...codexWriteArgs(ctx, how),
    ...codexSchemaArgs(ctx, how),
    ...optionArgs("-m", ctx.model),
    ...optionArgs("-c", framed('model_reasoning_effort="', ctx.effort, '"')),
    "-",
  ],
  /*
   * The ctx is the call: its job, its files and what it may do. The how is where it starts: a new
   * session, a fork or continuation of one, or FLAMME's seed.
   */
  cliArgs = (ctx: CliContext, how: CliHow): readonly string[] => {
    if (ctx.provider === "claude") {
      return claudeArgs(ctx, how);
    }
    return codexArgs(ctx, how);
  };

export { cliArgs };
