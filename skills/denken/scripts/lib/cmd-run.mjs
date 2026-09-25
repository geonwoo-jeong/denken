// Commands that create, start and report on a run.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveConfig } from "../config.mjs";
import { DENKEN_DIR, fail, hashFile, now, pad, print, REQUEST, ROOT, slug, UNITS } from "./core.mjs";
import { tokens } from "./findings.mjs";
import { gitText } from "./git.mjs";
import { agentLabel, choiceProblems, parseChoices, roleAgents } from "./levels.mjs";
import { assertLock } from "./lock.mjs";
import { readUnit } from "./parallel.mjs";
import { createLog, logRequest, timeline } from "./record.mjs";
import { requestProblems } from "./request.mjs";
import { enterStage } from "./stages.mjs";
import { callBase, load, readRunFile, runFields, save } from "./state.mjs";
import { createUnits, unitsProblems } from "./units.mjs";

export function cmdNew(name) {
  if (!name) fail("usage: new <slug>");
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = join(DENKEN_DIR, "runs", `${stamp}-${slug(name)}`);
  if (existsSync(dir)) fail(`run already exists: ${relative(ROOT, dir)}`);
  mkdirSync(join(dir, "calls"), { recursive: true });
  const ignore = join(DENKEN_DIR, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "runs/\nlocks/\nconfig.local.json\n");
  const state = { version: 1, task: name, created: now(), stage: "intake", log: createLog(name), verdicts: [] };
  state.verdictsSha = hashFile(join(ROOT, state.log, "verdicts.md"));
  timeline(state, "DENKEN", `run created: ${name}`);
  save(dir, state);
  print({ action: "created", run: relative(ROOT, dir), log: state.log, next: `Record your conversation with the user in ${relative(ROOT, join(dir, "conversation.md"))}, write ${relative(ROOT, join(dir, REQUEST))}, confirm it with the user, then run start.` });
}

export function cmdStart(runDir, args = []) {
  const state = load(runDir);
  if (state.stage !== "intake") fail(`run already started (stage: ${state.stage})`);
  const problems = requestProblems(readRunFile(runDir, REQUEST));
  if (problems.length) fail(problems.join("; "));
  if (gitText("rev-parse", "--is-inside-work-tree") !== "true") fail("DENKEN needs a git work tree to detect file changes; run git init first");
  const config = resolveConfig(ROOT);
  if (config.errors.length) {
    print({ action: "needs_user", reason: "config", errors: config.errors, warnings: config.warnings, next: "Fix the configuration with config.mjs, then run start again." });
    process.exit(1);
  }
  const split = existsSync(join(runDir, UNITS)) ? unitsProblems(runDir) : null;
  if (split?.problems.length) fail(`${UNITS}: ${split.problems.join("; ")}`);
  Object.assign(state, runFields({ crossProvider: config.crossProvider, sameReviewer: config.sameReviewer, allowSameReviewer: config.allowSameReviewer, stages: config.stages, limits: config.limits, levels: config.levels, warnings: config.warnings }, gitText("rev-parse", "-q", "--verify", "HEAD") || null));
  Object.assign(state, parseChoices(args));
  // DENKEN can turn seeds off for a small task (start --seeds off), or name the providers to seed.
  const seedsAt = args.indexOf("--seeds");
  const seedsArg = seedsAt >= 0 ? String(args[seedsAt + 1] ?? "") : null;
  if (seedsArg !== null && seedsArg !== "off" && !seedsArg.split(",").every((p) => ["claude", "codex"].includes(p))) fail("--seeds takes off, or the providers to seed: claude, codex, or claude,codex");
  state.seeding = seedsArg === null ? Object.keys(config.seeds ?? {}).filter((p) => config.seeds[p]) : seedsArg === "off" ? [] : seedsArg.split(",");
  // The levels DENKEN picked apply to every unit too, unless the unit's own line changes them.
  for (const u of split?.units ?? []) {
    const trial = { ...state, levels: { ...state.levels, ...u.levels } };
    for (const p of choiceProblems(trial)) fail(`${u.id}'s levels: ${p}`);
  }
  const chosen = choiceProblems(state);
  if (chosen.some((p) => p.includes("same model"))) {
    print({ action: "needs_user", reason: "same_reviewer", problems: chosen, next: "The same model would check its own work. Give the checker a different level (start --level <role>=<level>), or ask the user to set a different model or effort for it with config.mjs, or to set allowSameReviewer true. Then run start again." });
    process.exit(1);
  }
  if (chosen.length) fail(chosen.join("; "));
  logRequest(state, runDir);
  const agents = roleAgents(state);
  const roles = Object.entries(agents).map(([r, a]) => `${r.toUpperCase()}=${agentLabel(a)}`).join(" · ");
  timeline(state, "DENKEN", `the user agreed the request; run started (${roles}) → 00-request/request.md`);
  if (split) {
    timeline(state, "DENKEN", `the request is split into ${split.units.length} units, built in parallel: ${split.units.map((u) => `${u.id} (${u.reqs.join(", ")}) in ${u.scope.join(", ")}`).join("; ")} → 00-request/${UNITS}`);
    createUnits(runDir, state, split.units);
    state.stage = "units";
  } else enterStage(state, "plan");
  assertLock();
  save(runDir, state);
  print({ action: "started", log: state.log, run: relative(ROOT, runDir), units: state.units?.map((u) => ({ unit: u.id, reqs: u.reqs, scope: u.scope, levels: u.levels, worktree: u.root })) ?? null, crossProvider: config.crossProvider, roles: agents, stages: config.stages, limits: config.limits, warnings: config.warnings, next: "Run next with --wait." });
}

// The last thing a running call did, read from the tail of its streamed log.
export function lastActivity(logPath) {
  if (!existsSync(logPath)) return null;
  const { size, mtime } = statSync(logPath);
  const length = Math.min(size, 65536);
  const buffer = Buffer.alloc(length);
  const fd = openSync(logPath, "r");
  readSync(fd, buffer, 0, length, size - length);
  closeSync(fd);
  const describe = (e) => {
    const part = e.type === "assistant" ? e.message?.content?.findLast?.((c) => c.type === "tool_use" || c.type === "text") : null;
    if (part?.type === "tool_use") return `${part.name} ${JSON.stringify(part.input)}`;
    if (part?.type === "text") return part.text;
    if (e.item?.type === "command_execution") return `command: ${e.item.command}`;
    if (e.item?.type === "agent_message") return e.item.text;
    return e.item?.type ?? null;
  };
  for (const line of buffer.toString("utf8").split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const text = describe(JSON.parse(line));
      if (text) return { updated: mtime.toISOString(), last: String(text).replace(/\s+/g, " ").slice(0, 160) };
    } catch {}
  }
  return { updated: mtime.toISOString(), last: null };
}

// Tokens per role over the run's calls, and how much of the input came from the cache: the way to
// see whether a level or a prompt change saved anything.
export function tokenReport(runDir, s) {
  const byRole = {};
  for (const c of s.calls ?? []) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(`${callBase(runDir, c.id)}.meta.json`, "utf8"));
    } catch {
      continue;
    }
    const seedTokens = meta.seed?.facts?.tokens;
    if (seedTokens) {
      const f = (byRole.flamme ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
      f.calls++;
      for (const k of ["input", "output", "cacheRead", "cacheWrite"]) f[k] += seedTokens[k] ?? 0;
      f.costUsd += meta.seed.facts.costUsd ?? 0;
    }
    const t = meta.facts?.tokens;
    if (!t) continue;
    const role = c.id.split("-")[1];
    const r = (byRole[role] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
    r.calls++;
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) r[k] += t[k] ?? 0;
    r.costUsd += meta.facts.costUsd ?? 0;
  }
  for (const r of Object.values(byRole)) {
    const read = r.input + r.cacheRead + r.cacheWrite;
    r.fromCache = read ? `${Math.round((r.cacheRead / read) * 100)}%` : null;
    r.costUsd = Math.round(r.costUsd * 10000) / 10000;
  }
  return byRole;
}

export function cmdStatus(runDir) {
  const s = load(runDir);
  print({
    run: relative(ROOT, runDir),
    task: s.task,
    stage: s.stage,
    pending: s.pending,
    rounds: s.round,
    inflight: s.inflight && { call: s.inflight.id, provider: s.inflight.provider, started: s.inflight.started, activity: lastActivity(`${callBase(runDir, s.inflight.id)}.log`) },
    blocked: s.blocked && { kind: s.blocked.kind, reason: s.blocked.reason },
    approved: s.approved,
    topics: s.counts,
    deferred: s.deferred?.length ?? 0,
    rulings: s.rulings?.map((r) => `${r.id} ${r.stage} ${r.subject} ${r.decision}`),
    calls: s.calls?.slice(-6).map((c) => `${c.id} ${c.provider} ${c.status ?? "running"}`),
    roles: s.assignment ? Object.fromEntries(Object.entries(roleAgents(s)).map(([r, a]) => [r, agentLabel(a)])) : null,
    tokens: tokenReport(runDir, s),
    ...(s.units ? { units: s.units.map((u) => ({ unit: u.id, status: u.status, stage: readUnit(u)?.stage ?? null, reason: u.last?.reason ?? null, worktree: existsSync(u.root) ? u.root : null })) } : {}),
  });
}
