// Running one call, in the _exec process, phase by phase: continue the worker's session, or fork
// FLAMME's seed, or start fresh; then check the guards and judge the result.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cliArgs } from "./cli.mjs";
import { now, oneLine, ROOT, SKILL_DIR, TODO_QA, USAGE_LIMIT } from "./core.mjs";
import { gitText } from "./git.mjs";
import { pinOwned, snapshot, violations } from "./guard.mjs";
import { runCli } from "./process.mjs";
import { callBase, readRunFile } from "./state.mjs";
import { parseItems } from "./todo.mjs";

// CONTEXT_LOADED is FLAMME's answer when it seeds a checker (the seed shares the call's schema);
// from a real review or QA call it is not a result.
export function validOutput(mode, value) {
  if (mode === "review") {
    return ["APPROVED", "CHANGES_REQUESTED"].includes(value?.verdict) && Array.isArray(value.findings) &&
      value.findings.every((f) => ["blocking", "nonblocking"].includes(f.severity) && typeof f.topic === "string" && typeof f.problem === "string");
  }
  return ["PASS", "FAIL"].includes(value?.result) && Array.isArray(value.items) && value.items.length > 0 && value.items.every((c) => /^QA-\d{3,}$/.test(c.id) && ["PASS", "FAIL"].includes(c.result));
}

// What a CLI run reported: its session, the final message (written to outPath), denials, errors,
// and the facts of the run (model that ran, cost, tokens).
export function readRun(provider, logPath, structured, outPath) {
  const run = { sessionId: null, denials: [], error: null, errorText: "", facts: {} };
  const events = [];
  for (const line of (existsSync(logPath) ? readFileSync(logPath, "utf8") : "").split("\n")) {
    if (!line.startsWith("{")) {
      if (line.trim()) run.errorText += `${line}\n`;
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  if (provider === "claude") {
    // The model that actually ran: an alias or an allowlist can differ from what was asked for.
    const init = events.find((e) => e.type === "system" && e.subtype === "init");
    run.facts.modelRan = init?.model ?? null;
    run.sessionId = init?.session_id ?? null;
    const final = events.findLast((e) => e.type === "result");
    if (final) {
      run.denials = (final.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: d.tool_input }));
      if (final.is_error) {
        run.error = `claude reported an error: ${final.subtype ?? ""} ${final.api_error_status ?? ""}`.trim();
        run.errorText += `${final.result ?? ""} ${final.api_error_status ?? ""}\n`;
      }
      const output = structured ? final.structured_output : final.result;
      if (output != null) writeFileSync(outPath, structured ? JSON.stringify(output, null, 2) : String(output));
      run.facts.costUsd = final.total_cost_usd ?? null;
      run.facts.tokens = final.usage ? { input: final.usage.input_tokens ?? null, output: final.usage.output_tokens ?? null, cacheRead: final.usage.cache_read_input_tokens ?? null, cacheWrite: final.usage.cache_creation_input_tokens ?? null } : null;
      run.facts.turns = final.num_turns ?? null;
    }
  } else {
    for (const event of events) {
      if (event.type === "thread.started") run.sessionId = event.thread_id;
      if (event.type === "error" || event.type === "turn.failed") run.errorText += `${JSON.stringify(event)}\n`;
      if (event.type === "turn.completed" && event.usage) {
        run.facts.tokens ??= { input: 0, output: 0, cacheRead: 0 };
        run.facts.tokens.input += event.usage.input_tokens ?? 0;
        run.facts.tokens.output += event.usage.output_tokens ?? 0;
        run.facts.tokens.cacheRead += event.usage.cached_input_tokens ?? 0;
      }
    }
  }
  return run;
}

export async function execCall(runDir, id) {
  const c = openCall(runDir, id);
  const { job, meta } = c;
  // The guard: git's own files, and a snapshot of the project and DENKEN's files, taken before
  // anything runs. Everything the call changes is checked against them after it.
  const gitPinned = pinGitFiles();
  const before = snapshot(runDir, id, job.log);
  const pinned = pinOwned(before.owned);

  let ran = await continueSession(c);
  if (!ran) {
    // FLAMME's seed only reads: a seed that changed anything is a violation, and the call does not run.
    const seedBefore = c.seed && !c.seed.sessionId ? snapshot(runDir, id, job.log) : null;
    const forkOf = await seedToFork(c);
    if (seedBefore) {
      const changed = violations(seedBefore, snapshot(runDir, id, job.log), { frozen: true, ignored: "all", allow: [] }, runDir, pinned, id);
      if (changed.length) {
        Object.assign(meta, { status: "guard_violation", violations: changed.map((v) => `FLAMME's seed: ${v}`) });
        return closeCall(c);
      }
    }
    ran = await startCall(c, forkOf);
  }

  // After the call: git's own files are restored before the engine runs git again, then everything
  // else the call may not change is checked and DENKEN's files restored.
  const gitViolations = restoreGitFiles(gitPinned, runDir, id);
  takeRun(c, ran);
  meta.violations = [...gitViolations, ...violations(before, snapshot(runDir, id, job.log), job.guard, runDir, pinned, id)];
  judge(c, ran.result, runDir);
  closeCall(c);
}

// The call as its job describes it: its files, its prompt, and the facts recorded about it.
function openCall(runDir, id) {
  const base = callBase(runDir, id);
  // A heartbeat lets `next` tell a live call from a dead one even if the pid is reused.
  const beat = () => writeFileSync(`${base}.heartbeat`, now());
  beat();
  const heartbeat = setInterval(beat, 5000);
  const job = JSON.parse(readFileSync(`${base}.job.json`, "utf8"));
  const system = existsSync(`${base}.system.md`) ? readFileSync(`${base}.system.md`, "utf8") : "";
  const message = readFileSync(`${base}.prompt.md`, "utf8");
  const freshMessage = existsSync(`${base}.prompt.fresh.md`) ? readFileSync(`${base}.prompt.fresh.md`, "utf8") : message;
  const structured = job.mode !== "work";
  const schemaPath = join(SKILL_DIR, "schemas", `${job.mode}.schema.json`);
  const outPath = `${base}.out.${structured ? "json" : "md"}`;
  const { provider, model, effort } = job.agent;
  // Claude gets the role as an appended system prompt, identical for every call of the role, so
  // calls share a cached prefix. Codex gets one message.
  const prompt = job.seed || provider === "claude" || !system ? freshMessage : `${system}\n---\n\n${freshMessage}`;
  // Permissions DENKEN granted to this role on request widen the defaults, never a reviewer's.
  const grants = { network: false, domains: [], dirs: [], tools: [], ...job.agent.grants };
  const network = job.agent.network || grants.network;
  const meta = { status: "ok", nonce: job.nonce, exitCode: null, sessionId: null, denials: [], violations: [], error: null };
  const startedAt = Date.now();
  const facts = { provider, model: model ?? null, effort: effort ?? null, level: job.agent.level ?? null, cliVersion: (spawnSync(provider, ["--version"], { encoding: "utf8", timeout: 20000 }).stdout ?? "").trim().split("\n")[0] || null, head: gitText("rev-parse", "-q", "--verify", "HEAD") || null, stageBase: job.stageBase ?? null, grants: job.agent.grants ?? null };
  // The call runs fresh, continues the worker's session (job.continue), or forks the seed FLAMME made
  // for its kind (job.seed); lib/cli.mjs builds each command line.
  const seed = job.seed ?? null;
  const ctx = { job, provider, seed, system, base, outPath, structured, schemaPath, network, grants, model, effort };
  return {
    base, job, provider, structured, outPath, message, prompt, seed, meta, facts, startedAt, heartbeat,
    argsFor: (how) => cliArgs(ctx, how),
    // A seed's forks come minutes apart (rounds, the user's confirmation): the seed's prefix is written
    // to the cache for an hour rather than the default five minutes on API billing. Only the seed and
    // its re-warm write that way; a fork's own writes keep the default, cheaper rate.
    cacheEnv: seed && provider === "claude" ? { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" } : null,
  };
}

// A worker's later round continues its own session first. Null when there is none, or it cannot
// start: the call then starts the usual way.
async function continueSession(c) {
  const { job, meta, provider, base, outPath } = c;
  if (!job.continue) return null;
  meta.continue = { from: job.continue.from, sessionId: job.continue.sessionId, chain: job.continue.chain + 1, fallback: null };
  if (provider === "claude") meta.sessionId = randomUUID();
  const result = await runCli(provider, c.argsFor({ sessionId: meta.sessionId, forkOf: job.continue.sessionId, resume: true }), c.message, base, job.timeoutMs);
  const run = readRun(provider, `${base}.log`, c.structured, outPath);
  if (!result.timedOut && result.status !== 0 && !existsSync(outPath)) {
    meta.continue.fallback = `continuing ${job.continue.sessionId} failed: ${oneLine(run.error ?? run.errorText, 200)}`;
    renameSync(`${base}.log`, `${base}.continue-failed.log`);
    return null;
  }
  return { result, run };
}

// The session this call forks: FLAMME's seed for its kind, re-warmed when idle for close to the
// cache's hour, or made now. Null when the call has no seed, or FLAMME could not make one.
async function seedToFork(c) {
  const { job, meta, provider, base, seed, structured } = c;
  if (!seed) return null;
  let forkOf = seed.sessionId ?? null;
  meta.seed = { key: seed.key, sessionId: forkOf, created: false, rewarmed: false, fallback: null, facts: null };
  // A re-warm forks the seed once with nothing to do, and that session becomes the seed. Forks of a
  // stale seed would each pay for the whole prefix again.
  if (seed.rewarm && forkOf) {
    const warmId = randomUUID();
    const nothing = structured ? `Nothing to do yet. Answer exactly: ${job.mode === "review" ? '{"verdict": "CONTEXT_LOADED", "summary": "Context kept warm.", "findings": [], "checked": []}' : '{"result": "CONTEXT_LOADED", "summary": "Context kept warm.", "items": []}'}` : "Nothing to do yet. Answer exactly: READY";
    const r = await runCli(provider, c.argsFor({ sessionId: warmId, forkOf, out: `${base}.rewarm.out` }), nothing, `${base}.rewarm`, job.timeoutMs, c.cacheEnv);
    if (r.status === 0 && !r.timedOut) Object.assign(meta.seed, { sessionId: warmId, rewarmed: true });
    forkOf = meta.seed.sessionId;
  }
  if (!forkOf) {
    const seedSession = provider === "claude" ? randomUUID() : null;
    const seedStarted = Date.now();
    const r = await runCli(provider, c.argsFor({ sessionId: seedSession, forSeed: true, out: `${base}.seed.out.md` }), readFileSync(`${base}.seed.prompt.md`, "utf8"), `${base}.seed`, job.timeoutMs, c.cacheEnv);
    const run = readRun(provider, `${base}.seed.log`, structured, `${base}.seed.out.md`);
    const seedId = provider === "claude" ? seedSession : run.sessionId;
    meta.seed.facts = { ...run.facts, durationSec: Math.round((Date.now() - seedStarted) / 1000) };
    if (r.status === 0 && !r.timedOut && !run.error && seedId) Object.assign(meta.seed, { sessionId: seedId, created: true });
    else meta.seed.fallback = `FLAMME could not make the seed: ${oneLine(run.error ?? run.errorText ?? `exit ${r.status}`, 200)}`;
    forkOf = meta.seed.sessionId;
  }
  return forkOf;
}

// The call itself, as a fork of its seed or fresh. A fork that cannot start (its seed gone, say)
// runs once more from scratch.
async function startCall(c, forkOf) {
  const { job, meta, provider, base, outPath } = c;
  if (provider === "claude") meta.sessionId = randomUUID();
  let result = await runCli(provider, c.argsFor({ sessionId: meta.sessionId, forkOf }), c.prompt, base, job.timeoutMs);
  let run = readRun(provider, `${base}.log`, c.structured, outPath);
  if (forkOf && !result.timedOut && result.status !== 0 && !existsSync(outPath)) {
    meta.seed.fallback = `the fork of ${forkOf} failed: ${oneLine(run.error ?? run.errorText, 200)}`;
    renameSync(`${base}.log`, `${base}.fork-failed.log`);
    if (provider === "claude") meta.sessionId = randomUUID();
    result = await runCli(provider, c.argsFor({ sessionId: meta.sessionId }), c.prompt, base, job.timeoutMs);
    run = readRun(provider, `${base}.log`, c.structured, outPath);
  }
  return { result, run };
}

// Git's own config could make the engine's next git command run a program (fsmonitor, filters),
// and info/exclude could hide new files from the guard.
function pinGitFiles() {
  const files = ["config", "info/exclude"].map((f) => resolve(ROOT, gitText("rev-parse", "--git-path", f)));
  return Object.fromEntries(files.map((f) => [f, existsSync(f) ? readFileSync(f) : null]));
}
// Undoes any change to them, keeping what was written, before git runs again.
function restoreGitFiles(pinned, runDir, id) {
  const changed = [];
  for (const [f, was] of Object.entries(pinned)) {
    const current = existsSync(f) ? readFileSync(f) : null;
    if ((current === null) !== (was === null) || (current && !current.equals(was))) {
      const kept = join(runDir, "calls", `${id}.tampered`, "git", relative(resolve(ROOT, ".git"), f).replace(/^(\.\.\/)+/, ""));
      if (current) {
        mkdirSync(dirname(kept), { recursive: true });
        writeFileSync(kept, current);
      }
      if (was === null) rmSync(f, { force: true });
      else writeFileSync(f, was);
      changed.push(`git file changed: ${relative(ROOT, f)} (restored)`);
    }
  }
  return changed;
}

// What the run reported: its session, denials and errors, and the facts for the record.
function takeRun(c, { result, run }) {
  const { job, meta, facts, provider } = c;
  if (provider === "codex") meta.sessionId = run.sessionId;
  meta.denials = run.denials;
  if (run.error) meta.error = run.error;
  meta.errorText = run.errorText;
  Object.assign(facts, run.facts);
  if (meta.continue) facts.continued = meta.continue.fallback ? `not continued: ${meta.continue.fallback}` : `continued the session of ${meta.continue.from} (round ${meta.continue.chain} in it)`;
  if (meta.seed) facts.seed = meta.seed.fallback ? `not used: ${meta.seed.fallback}` : `forked from FLAMME's seed ${meta.seed.sessionId}${meta.seed.created ? ", made for this call" : ""}`;
  meta.exitCode = result.status;
  if (result.timedOut) meta.error = `timed out after ${Math.round(job.timeoutMs / 60000)} min`;
  else if (result.error) meta.error = result.error.message;
}

// How the call went: a violation, a timeout, a failure, or a final message that must also match
// its schema (and, for QA, list only the items in todo-qa.md).
function judge(c, result, runDir) {
  const { job, meta, provider, structured, outPath } = c;
  const errorText = meta.errorText;
  delete meta.errorText;
  const output = existsSync(outPath) ? readFileSync(outPath, "utf8").trim() : "";
  if (meta.violations.length) meta.status = "guard_violation";
  else if (result.timedOut) meta.status = "timeout";
  else if (result.status !== 0 || meta.error) {
    meta.status = USAGE_LIMIT.test(errorText) ? "usage_limit" : "failed";
    meta.error ??= `${provider} exited with ${result.status}`;
  } else if (!output) {
    meta.status = "failed";
    meta.error = "the agent produced no final message";
  } else if (structured) {
    let value = null;
    try {
      value = JSON.parse(output);
    } catch {}
    const qIds = new Set(parseItems(readRunFile(runDir, TODO_QA), "QA").items.map((q) => q.key));
    const unknown = job.mode === "qa" && validOutput("qa", value) ? value.items.filter((c) => !qIds.has(c.id)).map((c) => c.id) : [];
    if (!validOutput(job.mode, value)) {
      meta.status = "invalid_output";
      meta.error = "the final message does not match the schema";
    } else if (unknown.length) {
      meta.status = "invalid_output";
      meta.error = `the QA report has items that are not in todo-qa.md: ${unknown.join(", ")}`;
    }
  }
}

// The result file, with the call's facts; its appearance tells `next` the call is over.
function closeCall(c) {
  const { meta, facts, startedAt, base } = c;
  meta.finished = now();
  meta.facts = { ...facts, sessionId: meta.sessionId, exitCode: meta.exitCode, durationSec: Math.round((Date.now() - startedAt) / 1000) };
  clearInterval(c.heartbeat);
  writeMeta(base, meta);
}

// The result file is the signal that a call finished, so it is written atomically: `next`
// must never read a half-written one.
export function writeMeta(base, meta) {
  writeFileSync(`${base}.meta.json.tmp`, JSON.stringify(meta, null, 2));
  renameSync(`${base}.meta.json.tmp`, `${base}.meta.json`);
}

// ---------- ingesting results
