// Running one call, in the _exec process: the agent CLI with its seed or session, the guards around it, and its result.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cliArgs } from "./cli.mjs";
import { now, oneLine, ROOT, SKILL_DIR, sleep, TODO_QA, USAGE_LIMIT } from "./core.mjs";
import { gitText } from "./git.mjs";
import { pinOwned, snapshot, violations } from "./guard.mjs";
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

// ---------- process groups
// Each agent CLI leads its own process group, so the test runners, servers and shells it
// starts can be stopped with it. Signals go to the whole group (negative pid).

export function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export async function stopGroup(pgid) {
  if (!pgid || !signalGroup(pgid, 0)) return;
  signalGroup(pgid, "SIGTERM");
  for (let i = 0; i < 30 && signalGroup(pgid, 0); i++) await sleep(100);
  signalGroup(pgid, "SIGKILL");
}

// Stop a group only if its leader is still the agent CLI we started, never a reused pid.
export async function stopCallGroup(base, provider) {
  const pgid = Number(existsSync(`${base}.cli.pid`) ? readFileSync(`${base}.cli.pid`, "utf8") : 0);
  if (!pgid) return;
  const command = spawnSync("ps", ["-o", "command=", "-p", String(pgid)], { encoding: "utf8" }).stdout ?? "";
  if (command.includes(provider)) await stopGroup(pgid);
}

export async function runCli(provider, args, input, base, timeoutMs, env = null) {
  const logFd = openSync(`${base}.log`, "w");
  const child = spawn(provider, args, { cwd: ROOT, stdio: ["pipe", logFd, logFd], detached: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
  closeSync(logFd);
  if (child.pid) writeFileSync(`${base}.cli.pid`, String(child.pid));
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stopGroup(child.pid);
  }, timeoutMs);
  const result = await new Promise((done) => {
    child.on("error", (error) => done({ status: null, error }));
    child.on("exit", (status, signal) => done({ status, signal }));
  });
  clearTimeout(timer);
  await stopGroup(child.pid);
  return { ...result, timedOut };
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
  const argsFor = (how) => cliArgs(ctx, how);

  const gitFiles = ["config", "info/exclude"].map((f) => resolve(ROOT, gitText("rev-parse", "--git-path", f)));
  const gitPinned = Object.fromEntries(gitFiles.map((f) => [f, existsSync(f) ? readFileSync(f) : null]));
  const before = snapshot(runDir, id, job.log);
  const pinned = pinOwned(before.owned);

  // A worker's later round continues its own session first. If that cannot start, the call starts
  // the usual way below.
  let result = null;
  let run = null;
  if (job.continue) {
    meta.continue = { from: job.continue.from, sessionId: job.continue.sessionId, chain: job.continue.chain + 1, fallback: null };
    if (provider === "claude") meta.sessionId = randomUUID();
    result = await runCli(provider, argsFor({ sessionId: meta.sessionId, forkOf: job.continue.sessionId, resume: true }), message, base, job.timeoutMs);
    run = readRun(provider, `${base}.log`, structured, outPath);
    if (!result.timedOut && result.status !== 0 && !existsSync(outPath)) {
      meta.continue.fallback = `continuing ${job.continue.sessionId} failed: ${oneLine(run.error ?? run.errorText, 200)}`;
      renameSync(`${base}.log`, `${base}.continue-failed.log`);
      result = null;
    }
  }
  const started = !result;
  // FLAMME reads the role's context into a seed session, once; this call and the role's later calls
  // in the stage fork it. The seed only reads: a seed that changed anything is a violation.
  let forkOf = started ? seed?.sessionId ?? null : null;
  meta.seed = seed && started ? { key: seed.key, sessionId: forkOf, created: false, rewarmed: false, fallback: null, facts: null } : null;
  // A seed's forks come minutes apart (rounds, the user's confirmation): the seed's prefix is written
  // to the cache for an hour rather than the default five minutes on API billing. Only the seed and
  // its re-warm write that way; a fork's own writes keep the default, cheaper rate.
  const cacheEnv = seed && provider === "claude" ? { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" } : null;
  // A seed idle for close to that hour is re-warmed: forked once with nothing to do, and that
  // session becomes the seed. Forks of a stale seed would each pay for the whole prefix again.
  if (started && seed?.rewarm && forkOf) {
    const warmId = randomUUID();
    const nothing = structured ? `Nothing to do yet. Answer exactly: ${job.mode === "review" ? '{"verdict": "CONTEXT_LOADED", "summary": "Context kept warm.", "findings": [], "checked": []}' : '{"result": "CONTEXT_LOADED", "summary": "Context kept warm.", "items": []}'}` : "Nothing to do yet. Answer exactly: READY";
    const r = await runCli(provider, argsFor({ sessionId: warmId, forkOf, out: `${base}.rewarm.out` }), nothing, `${base}.rewarm`, job.timeoutMs, cacheEnv);
    if (r.status === 0 && !r.timedOut) Object.assign(meta.seed, { sessionId: warmId, rewarmed: true });
    forkOf = meta.seed.sessionId;
  }
  if (started && seed && !forkOf) {
    const seedBefore = snapshot(runDir, id, job.log);
    const seedSession = provider === "claude" ? randomUUID() : null;
    const seedStarted = Date.now();
    const r = await runCli(provider, argsFor({ sessionId: seedSession, forSeed: true, out: `${base}.seed.out.md` }), readFileSync(`${base}.seed.prompt.md`, "utf8"), `${base}.seed`, job.timeoutMs, cacheEnv);
    const run = readRun(provider, `${base}.seed.log`, structured, `${base}.seed.out.md`);
    const changed = violations(seedBefore, snapshot(runDir, id, job.log), { frozen: true, ignored: "all", allow: [] }, runDir, pinned, id);
    if (changed.length) {
      Object.assign(meta, { status: "guard_violation", violations: changed.map((v) => `FLAMME's seed: ${v}`), finished: now() });
      meta.facts = { ...facts, durationSec: Math.round((Date.now() - startedAt) / 1000) };
      clearInterval(heartbeat);
      return writeMeta(base, meta);
    }
    const seedId = provider === "claude" ? seedSession : run.sessionId;
    meta.seed.facts = { ...run.facts, durationSec: Math.round((Date.now() - seedStarted) / 1000) };
    if (r.status === 0 && !r.timedOut && !run.error && seedId) Object.assign(meta.seed, { sessionId: seedId, created: true });
    else meta.seed.fallback = `FLAMME could not make the seed: ${oneLine(run.error ?? run.errorText ?? `exit ${r.status}`, 200)}`;
    forkOf = meta.seed.sessionId;
  }

  if (started) {
    if (provider === "claude") meta.sessionId = randomUUID();
    result = await runCli(provider, argsFor({ sessionId: meta.sessionId, forkOf }), prompt, base, job.timeoutMs);
    run = readRun(provider, `${base}.log`, structured, outPath);
  }
  // A fork that could not start (its seed gone, say) runs once more from scratch.
  if (started && forkOf && !result.timedOut && result.status !== 0 && !existsSync(outPath)) {
    meta.seed.fallback = `the fork of ${forkOf} failed: ${oneLine(run.error ?? run.errorText, 200)}`;
    renameSync(`${base}.log`, `${base}.fork-failed.log`);
    if (provider === "claude") meta.sessionId = randomUUID();
    result = await runCli(provider, argsFor({ sessionId: meta.sessionId }), prompt, base, job.timeoutMs);
    run = readRun(provider, `${base}.log`, structured, outPath);
  }
  // Git's own config could make the engine's next git command run a program (fsmonitor, filters),
  // and info/exclude could hide new files from the guard. Undo any change before using git again.
  const gitViolations = [];
  for (const f of gitFiles) {
    const current = existsSync(f) ? readFileSync(f) : null;
    if ((current === null) !== (gitPinned[f] === null) || (current && !current.equals(gitPinned[f]))) {
      const kept = join(runDir, "calls", `${id}.tampered`, "git", relative(resolve(ROOT, ".git"), f).replace(/^(\.\.\/)+/, ""));
      if (current) {
        mkdirSync(dirname(kept), { recursive: true });
        writeFileSync(kept, current);
      }
      if (gitPinned[f] === null) rmSync(f, { force: true });
      else writeFileSync(f, gitPinned[f]);
      gitViolations.push(`git file changed: ${relative(ROOT, f)} (restored)`);
    }
  }
  if (provider === "codex") meta.sessionId = run.sessionId;
  meta.denials = run.denials;
  if (run.error) meta.error = run.error;
  const errorText = run.errorText;
  Object.assign(facts, run.facts);
  if (meta.continue) facts.continued = meta.continue.fallback ? `not continued: ${meta.continue.fallback}` : `continued the session of ${meta.continue.from} (round ${meta.continue.chain} in it)`;
  if (meta.seed) facts.seed = meta.seed.fallback ? `not used: ${meta.seed.fallback}` : `forked from FLAMME's seed ${meta.seed.sessionId}${meta.seed.created ? ", made for this call" : ""}`;
  meta.exitCode = result.status;
  if (result.timedOut) meta.error = `timed out after ${Math.round(job.timeoutMs / 60000)} min`;
  else if (result.error) meta.error = result.error.message;

  meta.violations = [...gitViolations, ...violations(before, snapshot(runDir, id, job.log), job.guard, runDir, pinned, id)];
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
  meta.finished = now();
  meta.facts = { ...facts, sessionId: meta.sessionId, exitCode: meta.exitCode, durationSec: Math.round((Date.now() - startedAt) / 1000) };
  clearInterval(heartbeat);
  writeMeta(base, meta);
}

// The result file is the signal that a call finished, so it is written atomically: `next`
// must never read a half-written one.
export function writeMeta(base, meta) {
  writeFileSync(`${base}.meta.json.tmp`, JSON.stringify(meta, null, 2));
  renameSync(`${base}.meta.json.tmp`, `${base}.meta.json`);
}

// ---------- ingesting results
