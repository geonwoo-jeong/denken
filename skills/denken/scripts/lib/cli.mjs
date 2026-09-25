// The agent CLIs' command lines. Claude and Codex differ in how a call starts (fresh, as FLAMME's
// seed, forking a seed, continuing a session), in how its sandbox is set, and in what they cache,
// so each has its own builder.
import { readFileSync } from "node:fs";

// ctx is the call: its job, its files and what it may do. how is where it starts: a new session
// (sessionId), a fork or continuation of one (forkOf, resume), or FLAMME's seed (forSeed).
export function cliArgs(ctx, how) {
  return ctx.provider === "claude" ? claudeArgs(ctx, how) : codexArgs(ctx, how);
}

// Both CLIs stream JSON events, which go straight to the call's log so `status` can show progress.
// A seeded call's role text is in its message and its flags are exactly the seed's, so a fork
// reads the seed from the cache.
function claudeArgs({ job, seed, system, base, structured, schemaPath, network, grants, model, effort }, { sessionId = null, forkOf = null }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--session-id", sessionId];
  if (forkOf) args.push("--resume", forkOf, "--fork-session");
  if (!seed && system) args.push("--append-system-prompt-file", `${base}.system.md`);
  // Moving cwd and git status out of the system prompt keeps it the same across directories
  // (units' worktrees) and for every fork of a seed.
  if (seed || (system && job.protect)) args.push("--exclude-dynamic-system-prompt-sections");
  // Reviewers and GENAU check other agents' work, so they load no project settings (a worker
  // could have planted hooks there) and no MCP servers.
  if (job.mode !== "work") args.push("--setting-sources", "user", "--strict-mcp-config");
  // Hooks belong to someone's interactive sessions (summaries of their past work, notifications);
  // in DENKEN's calls they would only add context the role must not rely on, and cost tokens.
  if (job.mode === "review") args.push("--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--settings", JSON.stringify({ disableAllHooks: true }));
  else {
    const sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };
    args.push("--permission-mode", "auto");
    if (!network) {
      // The strict allowlist covers sandboxed commands only; web tools and MCP servers
      // reach the network in-process, so they are removed too.
      sandbox.network = { strictAllowlist: true, allowedDomains: grants.domains ?? [] };
      args.push("--disallowedTools", "WebFetch,WebSearch");
      if (job.mode === "work") args.push("--strict-mcp-config");
    }
    // The sandbox bounds Bash; Claude's own file tools are bounded by permission rules. A unit's
    // agents may not edit the main checkout, which holds the other units' record.
    // "//" makes the rule path absolute; a single "/" would be relative to the settings source.
    const permissions = job.protect ? { deny: ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(/${job.protect}/**)`) } : undefined;
    args.push("--settings", JSON.stringify({ disableAllHooks: true, sandbox, ...(permissions ? { permissions } : {}) }));
    for (const dir of grants.dirs) args.push("--add-dir", dir);
    if (grants.tools.length) args.push("--allowedTools", grants.tools.join(","));
  }
  if (structured) args.push("--json-schema", readFileSync(schemaPath, "utf8"));
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

function codexArgs({ job, structured, schemaPath, network, grants, model, effort, outPath }, { forkOf = null, forSeed = false, out = outPath, resume = false }) {
  // A Codex seed only reads. A fork takes its sandbox from -c, and would otherwise keep the
  // seed's, so every fork sets it.
  const mode = forSeed || job.mode === "review" ? "read-only" : "workspace-write";
  // Codex continues a worker's session in place (exec resume), which keeps its cache.
  const args = forkOf ? ["exec", resume ? "resume" : "fork", forkOf, "--json", "-c", `sandbox_mode="${mode}"`, "-o", out] : ["exec", "--json", "-s", mode, "-o", out];
  if (!forSeed && network && job.mode !== "review") args.push("-c", "sandbox_workspace_write.network_access=true");
  if (!forSeed && job.mode !== "review" && grants.dirs.length) {
    if (forkOf) args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(grants.dirs)}`);
    else for (const dir of grants.dirs) args.push("--add-dir", dir);
  }
  if (structured && !forSeed) args.push("--output-schema", schemaPath);
  if (model) args.push("-m", model);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  args.push("-");
  return args;
}
