#!/usr/bin/env node
// Which AI provider (and optionally which model and effort) plays each DENKEN role.
//
//   node config.mjs [--json]                              show the resolved assignment
//   node config.mjs init [--local|--global]               save the current assignment as a config file
//   node config.mjs set <key> <value> [--local|--global]
//   node config.mjs unset <key> [--local|--global]
//   node config.mjs reset [--local|--global]              delete the config file
//
// Keys: <role>              provider: claude | codex | auto
//                           workers: methode (plan), stark (dev), serie (wiki)
//                           reviewers: richter (plan), ubel (dev), frieren (wiki); QA: genau
//       <role>.model        model name passed to the provider CLI
//       <role>.effort       reasoning effort passed to the provider CLI
//       <role>.network      true | false: network access for the role's commands
//                           (default: true for stark and genau, false for the others; reviewers never)
//       providers           comma-separated list of providers DENKEN may use
//       allowSameReviewer   true lets the same provider, model and effort check its own work
//       limits.topicRepeats, limits.roundsPerStage, limits.callTimeoutMin, limits.parallelUnits
//       levels.<provider>.<light|heavy>.<model|effort>
//                           what a level DENKEN picks for a stage means on each provider;
//                           "standard" is always the role's own model and effort
//
// Files, later ones override earlier ones. Run from the project root.
//   ~/.config/denken/config.json   --global  personal defaults for every project
//   .denken/config.json            (default) shared with the team; commit it
//   .denken/config.local.json      --local   personal override for this project; not committed
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED = ["claude", "codex"];
export const DEFAULT_LIMITS = { topicRepeats: 3, roundsPerStage: 5, callTimeoutMin: 60, parallelUnits: 3 };
// DENKEN picks a level per stage by the task's difficulty, to spend tokens where they matter.
// "standard" keeps the role's configured model and effort. The defaults change effort first and
// the model second, and use only the CLIs' model aliases, which never go stale; Codex has none,
// so its levels change effort only unless a model is configured here.
export const LEVELS = ["light", "standard", "heavy"];
// Heavy stops at "high": "max" tends to overthink. Which values a model accepts depends on it.
export const EFFORTS = { claude: ["low", "medium", "high", "xhigh", "max"], codex: ["low", "medium", "high", "xhigh", "max", "ultra"] };
export const DEFAULT_LEVELS = {
  claude: { light: { model: "sonnet", effort: "low" }, heavy: { model: "opus", effort: "high" } },
  codex: { light: { effort: "low" }, heavy: { effort: "high" } },
};
const WORKER = { plan: "methode", dev: "stark", wiki: "serie" };
const REVIEWER = { plan: "richter", dev: "ubel", wiki: "frieren" };
const ROLES = ["methode", "stark", "serie", "richter", "ubel", "frieren", "genau"];
const FIELDS = ["provider", "model", "effort", "network"];

export function configPaths(root = process.cwd()) {
  return {
    global: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "denken", "config.json"),
    shared: join(root, ".denken", "config.json"),
    local: join(root, ".denken", "config.local.json"),
  };
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`);
  }
}

const asSpec = (value) => (typeof value === "string" ? { provider: value } : { ...value });

function mergeRoles(layers) {
  const roles = {};
  for (const layer of layers) {
    for (const [role, value] of Object.entries(layer?.roles ?? {})) {
      roles[role] = { ...roles[role], ...asSpec(value) };
    }
  }
  return roles;
}

// Claude Code 2.1.271 is the first version with everything the engine relies on in its
// sandbox settings (strictAllowlist, per-command domains in auto mode). Older versions
// silently ignore those keys, which would leave the network open.
const MIN_VERSION = { claude: "2.1.271" };
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
};

// A provider is usable when its CLI is on PATH, recent enough and logged in.
// `problem` says why it is not; null means ready.
function probe(provider) {
  const installed = (process.env.PATH || "").split(delimiter).some((dir) => dir && existsSync(join(dir, provider)));
  if (!installed) return { problem: "not installed" };
  if (process.env.DENKEN_SKIP_AUTH_CHECK === "1") return { problem: null };
  if (MIN_VERSION[provider]) {
    const version = (spawnSync(provider, ["--version"], { encoding: "utf8", timeout: 20000 }).stdout ?? "").match(/\d+\.\d+\.\d+/)?.[0];
    if (!version || !newer(version, MIN_VERSION[provider])) return { problem: `version ${version ?? "unknown"} is older than ${MIN_VERSION[provider]}` };
  }
  const args = provider === "claude" ? ["auth", "status"] : ["login", "status"];
  const r = spawnSync(provider, args, { encoding: "utf8", timeout: 20000 });
  let loggedIn = r.status === 0;
  if (loggedIn && provider === "claude") {
    try {
      loggedIn = JSON.parse(r.stdout).loggedIn !== false;
    } catch {}
  }
  return { problem: loggedIn ? null : "not logged in" };
}

// Claude settings that re-open network hosts even when a role has network off.
function claudeNetworkHoles(root) {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const holes = [];
  for (const path of [join(home, "settings.json"), join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")]) {
    let settings;
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const rules = (settings.permissions?.allow ?? []).filter((r) => /^WebFetch\(domain:/.test(r));
    const domains = settings.sandbox?.network?.allowedDomains ?? [];
    if (rules.length || domains.length) holes.push(`${path}: ${[...rules, ...domains].join(", ")}`);
  }
  return holes;
}

export function resolveConfig(root = process.cwd()) {
  const paths = configPaths(root);
  const errors = [];
  const warnings = [];
  let layers;
  try {
    layers = [paths.global, paths.shared, paths.local].map(readJson);
  } catch (e) {
    return { errors: [e.message], warnings };
  }
  const sources = [paths.global, paths.shared, paths.local].filter((_, i) => layers[i]);

  const allowed = layers.reduce((acc, l) => l?.providers ?? acc, SUPPORTED);
  for (const p of allowed) if (!SUPPORTED.includes(p)) errors.push(`unsupported provider "${p}" (supported: ${SUPPORTED.join(", ")})`);
  const status = Object.fromEntries(SUPPORTED.map((p) => [p, probe(p)]));
  const usable = allowed.filter((p) => status[p] && !status[p].problem);
  if (usable.length === 0) {
    const state = SUPPORTED.map((p) => `${p}: ${status[p].problem ?? "ready"}`);
    errors.push(`no usable provider (${state.join(", ")}; allowed: ${allowed.join(", ")})`);
    return { errors, warnings, status, usable, sources };
  }

  const limits = { ...DEFAULT_LIMITS };
  for (const l of layers) Object.assign(limits, l?.limits);
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_LIMITS)) errors.push(`unknown limit "${key}"`);
    else if (key === "callTimeoutMin" ? !(value > 0) : !Number.isInteger(value) || value < 1) errors.push(`limits.${key} must be a positive ${key === "callTimeoutMin" ? "number" : "integer"}`);
  }
  const allowSameReviewer = layers.reduce((acc, l) => l?.allowSameReviewer ?? acc, false) === true;
  const levels = JSON.parse(JSON.stringify(DEFAULT_LEVELS));
  for (const l of layers) {
    for (const [provider, byLevel] of Object.entries(l?.levels ?? {})) {
      if (!SUPPORTED.includes(provider)) {
        errors.push(`levels.${provider}: unsupported provider`);
        continue;
      }
      for (const [level, spec] of Object.entries(byLevel ?? {})) {
        if (!["light", "heavy"].includes(level)) errors.push(`levels.${provider}.${level}: only light and heavy can be configured (standard is the role's own model and effort)`);
        else levels[provider][level] = { ...levels[provider][level], ...spec };
      }
    }
  }
  for (const [provider, byLevel] of Object.entries(levels)) {
    for (const [level, spec] of Object.entries(byLevel)) {
      if (spec.effort != null && !EFFORTS[provider].includes(spec.effort)) errors.push(`levels.${provider}.${level}.effort must be one of ${EFFORTS[provider].join(", ")}`);
    }
  }

  const roles = mergeRoles(layers);
  const [first, second = first] = usable;
  const defaultProvider = { methode: first, stark: second, serie: first };

  // Resolve a role spec to a concrete agent. `avoid` is the worker's provider, for reviewers.
  // Reviewers never get network access: they are read-only and run nothing that needs it.
  const pick = (label, spec, fallback, avoid, networkDefault = false) => {
    const other = avoid ? usable.find((p) => p !== avoid) ?? avoid : fallback;
    let provider = spec.provider ?? "auto";
    if (provider === "auto") provider = other;
    else if (!SUPPORTED.includes(provider)) {
      errors.push(`${label} is "${provider}" (use ${SUPPORTED.join(", ")} or auto)`);
      provider = other;
    } else if (!usable.includes(provider)) {
      const why = !allowed.includes(provider) ? "not in providers" : status[provider].problem;
      warnings.push(`${label} is set to ${provider}, which is ${why} here; using ${other} instead`);
      provider = other;
    }
    const network = Object.values(REVIEWER).includes(label) ? false : typeof spec.network === "boolean" ? spec.network : networkDefault;
    return { provider, model: spec.model ?? null, effort: spec.effort ?? null, network };
  };

  const stages = {};
  for (const [stage, role] of Object.entries(WORKER)) {
    const worker = pick(role, roles[role] ?? {}, defaultProvider[role], null, role === "stark");
    const reviewer = pick(REVIEWER[stage], roles[REVIEWER[stage]] ?? {}, null, worker.provider);
    stages[stage] = { worker, reviewer };
  }
  stages.qa = { runner: pick("genau", roles.genau ?? {}, null, stages.dev.worker.provider, true) };

  // With two providers the reviewer must be the other one. With one, the same provider may
  // review only if model or effort differ, or the user explicitly allowed it.
  const crossProvider = usable.length > 1;
  const same = (a, b) => a.provider === b.provider && a.model === b.model && a.effort === b.effort;
  const sameReviewer = [];
  for (const stage of Object.keys(WORKER)) {
    const { worker, reviewer } = stages[stage];
    if (crossProvider && worker.provider === reviewer.provider) {
      errors.push(`${stage}: ${WORKER[stage]} and ${REVIEWER[stage]} are both ${worker.provider}; the reviewer must use a different provider`);
    } else if (same(worker, reviewer)) sameReviewer.push(stage);
  }
  if (crossProvider && stages.qa.runner.provider === stages.dev.worker.provider) {
    errors.push(`qa: genau and stark are both ${stages.dev.worker.provider}; QA must use a different provider`);
  } else if (same(stages.qa.runner, stages.dev.worker)) sameReviewer.push("qa");
  const offline = Object.values(stages).flatMap((s) => Object.values(s)).some((a) => a.provider === "claude" && !a.network);
  const holes = offline ? claudeNetworkHoles(root) : [];
  if (holes.length) warnings.push(`Claude roles with network off can still reach hosts your Claude settings allow: ${holes.join("; ")}`);
  if (sameReviewer.length && !allowSameReviewer) {
    warnings.push(`the same model checks its own work in ${sameReviewer.join(", ")}; runs will not start until you give the reviewer (${sameReviewer.map((st) => (st === "qa" ? "genau" : REVIEWER[st])).join(", ")}) a different model or effort, or set allowSameReviewer true`);
  }

  return { errors, warnings, status, usable, crossProvider, sameReviewer, allowSameReviewer, sources, stages, limits, levels };
}

// ---------- CLI

function describe(agent) {
  const extras = [agent.model, agent.effort && `effort ${agent.effort}`, agent.network && "network"].filter(Boolean);
  return `${agent.provider}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

function show(json) {
  const r = resolveConfig();
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.errors.length ? 1 : 0);
  }
  if (r.status) {
    const state = SUPPORTED.map((p) => `${p} ${r.status[p].problem ?? "ready"}`);
    console.log(`Providers: ${state.join(", ")}`);
  }
  console.log(`Config:    ${r.sources?.length ? r.sources.join(" + ") : "defaults (no config file yet)"}`);
  if (r.stages) {
    console.log(`Mode:      ${r.crossProvider ? "cross-provider" : "single-provider"}`);
    console.log(`Limits:    DENKEN steps in when a topic is raised ${r.limits.topicRepeats} times, the loop stalls, or a stage reaches ${r.limits.roundsPerStage} rounds; each call times out after ${r.limits.callTimeoutMin} min; at most ${r.limits.parallelUnits} units work at once\n`);
    const row = (a, b, c) => console.log(`  ${a.padEnd(5)} ${b.padEnd(28)} ${c}`);
    row("stage", "worker", "reviewer / runner");
    for (const [stage, role] of Object.entries(WORKER)) {
      row(stage, `${role.toUpperCase()} → ${describe(r.stages[stage].worker)}`, `${REVIEWER[stage].toUpperCase()} → ${describe(r.stages[stage].reviewer)}`);
      if (stage === "dev") row("qa", "", `GENAU → ${describe(r.stages.qa.runner)}`);
    }
    const level = (spec) => [spec.model, spec.effort && `effort ${spec.effort}`].filter(Boolean).join(", ") || "as configured";
    console.log(`\nLevels DENKEN picks per stage by difficulty (standard = each role as configured above):`);
    for (const provider of SUPPORTED) console.log(`  ${provider.padEnd(7)} light: ${level(r.levels[provider].light)} · heavy: ${level(r.levels[provider].heavy)}`);
  }
  for (const w of r.warnings) console.log(`\nwarning: ${w}`);
  for (const e of r.errors) console.error(`\nerror: ${e}`);
  process.exit(r.errors.length ? 1 : 0);
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// Returns [object, key] addressing the value for a dotted config key.
function locate(config, key, create) {
  const parts = key.split(".");
  const [head, a] = parts;
  if ((head === "providers" || head === "allowSameReviewer") && parts.length === 1) return [config, head];
  if (head === "levels" && parts.length === 4 && SUPPORTED.includes(a) && ["light", "heavy"].includes(parts[2]) && ["model", "effort"].includes(parts[3])) {
    const levels = create ? (config.levels ??= {}) : config.levels ?? {};
    const byProvider = create ? (levels[a] ??= {}) : levels[a] ?? {};
    const spec = create ? (byProvider[parts[2]] ??= {}) : byProvider[parts[2]] ?? {};
    return [spec, parts[3]];
  }
  if (head === "limits" && parts.length === 2 && a in DEFAULT_LIMITS) {
    if (create) config.limits ??= {};
    return [config.limits ?? {}, a];
  }
  if (!ROLES.includes(head)) return null;
  const roles = create ? (config.roles ??= {}) : config.roles ?? {};
  if (create || roles[head]) roles[head] = asSpec(roles[head] ?? {});
  const spec = roles[head] ?? {};
  if (parts.length === 1) return [spec, "provider"];
  if (parts.length === 2 && FIELDS.includes(a)) return [spec, a];
  return null;
}

function update(path, mutate) {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : null;
  const config = previous ? JSON.parse(previous) : {};
  mutate(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const ignore = join(dirname(configPaths().shared), ".gitignore");
  if (path !== configPaths().global && !existsSync(ignore)) writeFileSync(ignore, "runs/\nlocks/\nconfig.local.json\n");
  const { errors } = resolveConfig();
  if (errors.length) {
    if (previous === null) rmSync(path);
    else writeFileSync(path, previous);
    fail(`not saved:\n  ${errors.join("\n  ")}`);
  }
  console.log(`Saved ${path}\n`);
  show(false);
}

function main() {
  const args = process.argv.slice(2);
  const paths = configPaths();
  const target = args.includes("--global") ? paths.global : args.includes("--local") ? paths.local : paths.shared;
  const [command, key, value] = args.filter((a) => !a.startsWith("--"));
  const keyHelp = `Keys: <role>[.model|.effort|.network] (roles: ${ROLES.join(", ")}), providers, allowSameReviewer, limits.topicRepeats, limits.roundsPerStage, limits.callTimeoutMin, limits.parallelUnits, levels.<claude|codex>.<light|heavy>.<model|effort>`;

  if (!command) return show(args.includes("--json"));
  if (command === "init") {
    if (existsSync(target)) fail(`${target} already exists; change it with set, or start over with reset`);
    const r = resolveConfig();
    if (r.errors.length) fail(r.errors.join("\n  "));
    const provider = (agent) => ({ provider: agent.provider });
    const auto = { provider: "auto" };
    const roles = { methode: provider(r.stages.plan.worker), stark: provider(r.stages.dev.worker), serie: provider(r.stages.wiki.worker), richter: auto, ubel: auto, frieren: auto, genau: auto };
    return update(target, (config) => Object.assign(config, { roles }));
  }
  if (command === "set") {
    if (!key || value === undefined) fail(`usage: set <key> <value>\n${keyHelp}`);
    return update(target, (config) => {
      const slot = locate(config, key, true);
      if (!slot) fail(`unknown key "${key}". ${keyHelp}`);
      const [obj, field] = slot;
      if (field === "network" || field === "allowSameReviewer") {
        if (!["true", "false"].includes(value)) fail(`${key} must be true or false`);
        obj[field] = value === "true";
      } else obj[field] = key === "providers" ? value.split(",").map((s) => s.trim()).filter(Boolean) : key.startsWith("limits.") ? Number(value) : value;
    });
  }
  if (command === "unset") {
    if (!key) fail(`usage: unset <key>\n${keyHelp}`);
    return update(target, (config) => {
      const slot = locate(config, key, false);
      if (!slot) fail(`unknown key "${key}". ${keyHelp}`);
      delete slot[0][slot[1]];
    });
  }
  if (command === "reset") {
    rmSync(target, { force: true });
    console.log(`Removed ${target}\n`);
    return show(false);
  }
  fail(`unknown command "${command}". Use: (none) | init | set | unset | reset`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
