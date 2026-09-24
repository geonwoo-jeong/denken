#!/usr/bin/env node
// DENKEN run engine: a deterministic state machine for the stage loop.
// DENKEN (the LLM) handles intake, rulings and talking to the user. This script handles the rest:
// which call runs next, launching it as a separate agent process, guarding files, parsing
// verdicts, counting repeated topics, and every write to state.json.
//
//   node denken.mjs new <slug>                  create .denken/runs/<id>/ and print its path
//   node denken.mjs start <run>                 check brief.md, snapshot the role assignment, begin plan
//   node denken.mjs next <run> [--wait <sec>]   advance the run; prints one JSON action
//   node denken.mjs rule <run> --decision <uphold|dismiss|replan|abort> (--note <text> | --note-file <path>)
//                   [--identities <a,b>]        which open findings a dismissal covers
//   (start, next, rule and retry take a per-run lock, so only one engine process works on a run.)
//   node denken.mjs retry <run>                 resume after a needs_user block
//   node denken.mjs status <run>                compact summary
//
// Actions printed by next: running | needs_ruling | needs_user | done | aborted.
// Run from the project root.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const SKILL_DIR = join(dirname(SCRIPT), "..");
const ROOT = process.cwd();
const DENKEN_DIR = join(ROOT, ".denken");
const NOT_DENKEN = ":(exclude).denken";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const NEXT_STAGE = { plan: "dev", dev: "qa", qa: "wiki", wiki: "done" };
const WORKER = { plan: "methode", dev: "stark", wiki: "serie" };
const ARTIFACT = { plan: "plan.md", dev: "dev-report.md", wiki: "wiki-report.md" };
const USAGE_LIMIT = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/i;

// ---------- helpers

const print = (value) => console.log(JSON.stringify(value, null, 2));
function fail(message) {
  print({ action: "error", error: message });
  process.exit(1);
}
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hashFile = (path) => {
  try {
    return sha(readFileSync(path));
  } catch {
    return "missing";
  }
};
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(...args) {
  const r = spawnSync("git", args, { cwd: ROOT, maxBuffer: 1 << 30 });
  return r.status === 0 ? r.stdout : Buffer.alloc(0);
}
const gitText = (...args) => git(...args).toString("utf8").trim();

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// ---------- state

function runDirOf(arg) {
  if (!arg) fail("missing <run> argument");
  const dir = resolve(ROOT, arg);
  if (!existsSync(join(dir, "state.json"))) fail(`not a run directory: ${arg}`);
  return dir;
}
function load(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch (e) {
    fail(`${join(dir, "state.json")} is unreadable: ${e.message}`);
  }
}
function save(dir, state) {
  const tmp = join(dir, "state.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, join(dir, "state.json"));
}
const callBase = (dir, id) => join(dir, "calls", id);

// ---------- file guard

function snapshot(runDir, callId) {
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z", "--", ".", NOT_DENKEN).toString().split("\0").filter(Boolean);
  const project = sha(
    Buffer.concat([
      git("rev-parse", "-q", "--verify", "HEAD"),
      git("status", "--porcelain=v1", "--untracked-files=all", "--", ".", NOT_DENKEN),
      git("diff", "--binary", "--", ".", NOT_DENKEN),
      git("diff", "--cached", "--binary", "--", ".", NOT_DENKEN),
      ...untracked.map((f) => Buffer.from(`${f}\0${hashFile(join(ROOT, f))}\n`)),
    ]),
  );
  // Ignored files such as .env: hash the ones that exist, skip ignored directories (caches, builds).
  const ignored = {};
  for (const f of git("ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", ".", NOT_DENKEN).toString().split("\0")) {
    if (f && !f.endsWith("/")) ignored[f] = hashFile(join(ROOT, f));
  }
  // Files DENKEN owns: config, and everything in the run directory except this call's own files.
  const owned = {};
  for (const name of ["config.json", "config.local.json"]) {
    const p = join(DENKEN_DIR, name);
    if (existsSync(p)) owned[relative(ROOT, p)] = hashFile(p);
  }
  for (const p of listFiles(runDir)) {
    if (!relative(runDir, p).startsWith(`calls/${callId}.`)) owned[relative(ROOT, p)] = hashFile(p);
  }
  return { project, ignored, owned };
}

// DENKEN's own files are restored from `pinned` when a call changes them. Project files are
// only reported: they belong to the user, who decides what to keep.
function violations(before, after, guard, runDir, pinned) {
  const found = [];
  if (guard.frozen && before.project !== after.project) found.push("project files changed (inspect with git status and git diff)");
  // QA runs tests, which often rewrite ignored reports (coverage.xml and the like), so QA is
  // held only to env files. Reviewers and the planner run nothing and are held to all of them.
  const watched = guard.ignored === "all" ? () => true : guard.ignored === "env" ? (f) => /(^|\/)\.env/.test(f) : () => false;
  for (const [f, h] of Object.entries(before.ignored)) {
    if (watched(f) && hashFile(join(ROOT, f)) !== h) found.push(`ignored file changed: ${f}`);
  }
  const allowed = new Set(guard.allow.map((f) => relative(ROOT, join(runDir, f))));
  for (const f of new Set([...Object.keys(before.owned), ...Object.keys(after.owned)])) {
    if (before.owned[f] === after.owned[f] || allowed.has(f)) continue;
    const path = join(ROOT, f);
    if (f in pinned) writeFileSync(path, pinned[f]);
    else if (!(f in before.owned)) rmSync(path, { force: true });
    found.push(`DENKEN file changed: ${f}${f in pinned || !(f in before.owned) ? " (restored)" : ""}`);
  }
  return found;
}

function pinOwned(owned) {
  const pinned = {};
  for (const f of Object.keys(owned)) if (!f.endsWith(".log")) pinned[f] = readFileSync(join(ROOT, f));
  return pinned;
}

// ---------- prompts

function knownTopics(state, stage) {
  const seen = new Map();
  for (const f of state.findings[stage] ?? []) seen.set(f.identity, { identity: f.identity, topic: f.topic, file: f.file, criterion: f.criterion, raised: state.counts[stage]?.[f.identity] ?? 0 });
  return [...seen.values()];
}

function buildCall(runDir, state, call) {
  const p = (f) => join(runDir, f);
  const read = [p("brief.md")];
  const write = [];
  const frozen = call.mode !== "work" || call.stage === "plan";
  const guard = { frozen, ignored: call.mode === "qa" ? "env" : frozen ? "all" : "none", allow: [] };
  const extra = [];
  const lastReview = state.lastReview[call.stage];

  if (call.mode === "work") {
    if (call.stage !== "plan") read.push(p("plan.md"));
    if (call.stage === "wiki") read.push(p("dev-report.md"), state.lastQa);
    if (call.stage === "dev" && state.devInput === "qa") read.push(state.lastQa);
    else if (call.round > 1 && lastReview) read.push(lastReview);
    write.push(p(ARTIFACT[call.stage]));
    guard.allow.push(ARTIFACT[call.stage]);
    if (call.stage === "plan") extra.push("Do not change any project file. Write only plan.md.");
  } else if (call.mode === "review") {
    if (call.stage !== "plan") read.push(p("plan.md"));
    read.push(p(ARTIFACT[call.stage]));
    if (call.stage !== "plan") {
      const diffPath = `${callBase(runDir, call.id)}.diff`;
      const base = state.stageBase[call.stage] || EMPTY_TREE;
      writeFileSync(diffPath, Buffer.concat([git("diff", base, "--", ".", NOT_DENKEN), Buffer.from("\n# Untracked files (read them directly)\n"), git("ls-files", "--others", "--exclude-standard", "--", ".", NOT_DENKEN)]));
      read.push(diffPath);
    }
    if (lastReview) read.push(lastReview);
    const topics = knownTopics(state, call.stage);
    if (topics.length) extra.push(`Known topics in this stage. For the same issue, reuse the same topic, file and criterion:\n${topics.map((t) => `  - ${t.identity} (topic "${t.topic}", file ${t.file ?? "none"}, criterion ${t.criterion ?? "none"}, raised ${t.raised}x)`).join("\n")}`);
    const dismissed = state.dismissed[call.stage] ?? [];
    if (dismissed.length) extra.push(`Dismissed by DENKEN. Do not raise these again: ${dismissed.join(", ")}`);
    const denials = state.lastWork[call.stage]?.denials ?? [];
    if (denials.length) extra.push(`The worker had ${denials.length} action(s) blocked by permissions in its last call. Check that nothing the work depends on was skipped:\n${denials.map((d) => `  - ${d.tool}: ${JSON.stringify(d.input).slice(0, 200)}`).join("\n")}`);
  } else {
    read.push(p("plan.md"));
  }
  if (existsSync(p("rulings.md"))) read.push(p("rulings.md"));

  const agent = agentFor(state, call);
  const roleText = readFileSync(join(SKILL_DIR, "roles", `${call.role}.md`), "utf8");
  const lines = [
    roleText.trimEnd(),
    "",
    "---",
    "",
    "## This call",
    "",
    `- Stage: ${call.stage}, round ${call.round}. You run on ${agent.provider}${agent.model ? ` (${agent.model})` : ""}.`,
    `- Project root: ${ROOT}`,
    `- Run directory: ${runDir}`,
    `- Read:\n${read.map((f) => `  - ${f}`).join("\n")}`,
  ];
  if (write.length) lines.push(`- Write:\n${write.map((f) => `  - ${f}`).join("\n")}`);
  for (const e of extra) lines.push(`- ${e}`);
  if (call.mode !== "work") lines.push("- Your final message must be JSON that matches the provided schema.");
  return { prompt: `${lines.join("\n")}\n`, guard, agent };
}

function agentFor(state, call) {
  const s = state.assignment.stages[call.stage];
  return call.mode === "qa" ? s.runner : call.mode === "work" ? s.worker : s.reviewer;
}

// ---------- launching and executing calls

function nextCall(state) {
  if (state.retryCall) {
    const c = state.retryCall;
    state.retryCall = null;
    return c;
  }
  const stage = state.stage;
  if (stage === "qa") return { stage, role: "genau", mode: "qa", round: ++state.round.qa, attempt: 1 };
  if (state.pending === "work") return { stage, role: WORKER[stage], mode: "work", round: ++state.round[stage], attempt: 1 };
  return { stage, role: "richter", mode: "review", round: state.round[stage], attempt: 1 };
}

function launch(runDir, state) {
  const call = nextCall(state);
  call.id = `${call.stage}-${call.role}-${call.round}`;
  call.nonce = randomUUID();
  const base = callBase(runDir, call.id);
  const { prompt, guard, agent } = buildCall(runDir, state, call);
  // Keep an earlier attempt's files for debugging, out of the way of the new attempt.
  const stamp = Date.now();
  for (const suffix of [".meta.json", ".pid", ".cli.pid", ".heartbeat", ".out.json", ".out.md", ".log"]) {
    if (existsSync(base + suffix)) renameSync(base + suffix, `${base}.prev-${stamp}${suffix}`);
  }
  writeFileSync(`${base}.prompt.md`, prompt);
  const timeoutMs = Math.round(state.assignment.limits.callTimeoutMin * 60000);
  writeFileSync(`${base}.job.json`, JSON.stringify({ ...call, agent, guard, timeoutMs }, null, 2));
  state.inflight = { ...call, provider: agent.provider, started: now() };
  state.calls.push({ id: call.id, mode: call.mode, provider: agent.provider, model: agent.model, attempt: call.attempt, started: state.inflight.started });
  save(runDir, state);
  const child = spawn(process.execPath, [SCRIPT, "_exec", runDir, call.id], { cwd: ROOT, detached: true, stdio: "ignore" });
  writeFileSync(`${base}.pid`, String(child.pid));
  child.unref();
}

function validOutput(mode, value) {
  if (mode === "review") {
    return ["APPROVED", "CHANGES_REQUESTED"].includes(value?.verdict) && Array.isArray(value.findings) &&
      value.findings.every((f) => ["blocking", "nonblocking"].includes(f.severity) && typeof f.topic === "string" && typeof f.problem === "string");
  }
  return ["PASS", "FAIL"].includes(value?.result) && Array.isArray(value.criteria) && value.criteria.length > 0 && value.criteria.every((c) => Number.isInteger(c.id) && ["PASS", "FAIL"].includes(c.result));
}

// ---------- process groups
// Each agent CLI leads its own process group, so the test runners, servers and shells it
// starts can be stopped with it. Signals go to the whole group (negative pid).

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

async function stopGroup(pgid) {
  if (!pgid || !signalGroup(pgid, 0)) return;
  signalGroup(pgid, "SIGTERM");
  for (let i = 0; i < 30 && signalGroup(pgid, 0); i++) await sleep(100);
  signalGroup(pgid, "SIGKILL");
}

// Stop a group only if its leader is still the agent CLI we started, never a reused pid.
async function stopCallGroup(base, provider) {
  const pgid = Number(existsSync(`${base}.cli.pid`) ? readFileSync(`${base}.cli.pid`, "utf8") : 0);
  if (!pgid) return;
  const command = spawnSync("ps", ["-o", "command=", "-p", String(pgid)], { encoding: "utf8" }).stdout ?? "";
  if (command.includes(provider)) await stopGroup(pgid);
}

async function runCli(provider, args, input, base, timeoutMs) {
  const logFd = openSync(`${base}.log`, "w");
  const child = spawn(provider, args, { cwd: ROOT, stdio: ["pipe", logFd, logFd], detached: true });
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

async function execCall(runDir, id) {
  const base = callBase(runDir, id);
  // A heartbeat lets `next` tell a live call from a dead one even if the pid is reused.
  const beat = () => writeFileSync(`${base}.heartbeat`, now());
  beat();
  const heartbeat = setInterval(beat, 5000);
  const job = JSON.parse(readFileSync(`${base}.job.json`, "utf8"));
  const prompt = readFileSync(`${base}.prompt.md`, "utf8");
  const structured = job.mode !== "work";
  const schemaPath = join(SKILL_DIR, "schemas", `${job.mode}.schema.json`);
  const outPath = `${base}.out.${structured ? "json" : "md"}`;
  const { provider, model, effort, network } = job.agent;
  const meta = { status: "ok", nonce: job.nonce, exitCode: null, sessionId: null, denials: [], violations: [], error: null };
  let errorText = "";

  // Both CLIs stream JSON events; they go straight to the log so `status` can show progress.
  let args;
  if (provider === "claude") {
    meta.sessionId = randomUUID();
    args = ["-p", "--output-format", "stream-json", "--verbose", "--session-id", meta.sessionId];
    if (job.mode === "review") args.push("--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--strict-mcp-config");
    else {
      const sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };
      args.push("--permission-mode", "auto");
      if (!network) {
        // The strict allowlist covers sandboxed commands only; web tools and MCP servers
        // reach the network in-process, so they are removed too.
        sandbox.network = { strictAllowlist: true, allowedDomains: [] };
        args.push("--disallowedTools", "WebFetch,WebSearch", "--strict-mcp-config");
      }
      args.push("--settings", JSON.stringify({ sandbox }));
    }
    if (structured) args.push("--json-schema", readFileSync(schemaPath, "utf8"));
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
  } else {
    args = ["exec", "--json", "-s", job.mode === "review" ? "read-only" : "workspace-write", "-o", outPath];
    if (network && job.mode !== "review") args.push("-c", "sandbox_workspace_write.network_access=true");
    if (structured) args.push("--output-schema", schemaPath);
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    args.push("-");
  }

  const before = snapshot(runDir, id);
  const pinned = pinOwned(before.owned);
  const result = await runCli(provider, args, prompt, base, job.timeoutMs);

  const events = [];
  for (const line of readFileSync(`${base}.log`, "utf8").split("\n")) {
    if (!line.startsWith("{")) {
      if (line.trim()) errorText += `${line}\n`;
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  if (provider === "claude") {
    const final = events.findLast((e) => e.type === "result");
    if (final) {
      meta.denials = (final.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: d.tool_input }));
      if (final.is_error) {
        meta.error = `claude reported an error: ${final.subtype ?? ""} ${final.api_error_status ?? ""}`.trim();
        errorText += `${final.result ?? ""} ${final.api_error_status ?? ""}\n`;
      }
      const output = structured ? final.structured_output : final.result;
      if (output != null) writeFileSync(outPath, structured ? JSON.stringify(output, null, 2) : String(output));
    }
  } else {
    for (const event of events) {
      if (event.type === "thread.started") meta.sessionId = event.thread_id;
      if (event.type === "error" || event.type === "turn.failed") errorText += `${JSON.stringify(event)}\n`;
    }
  }
  meta.exitCode = result.status;
  if (result.timedOut) meta.error = `timed out after ${Math.round(job.timeoutMs / 60000)} min`;
  else if (result.error) meta.error = result.error.message;

  meta.violations = violations(before, snapshot(runDir, id), job.guard, runDir, pinned);
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
    if (!validOutput(job.mode, value)) {
      meta.status = "invalid_output";
      meta.error = "the final message does not match the schema";
    }
  }
  meta.finished = now();
  clearInterval(heartbeat);
  writeMeta(base, meta);
}

// The result file is the signal that a call finished, so it is written atomically: `next`
// must never read a half-written one.
function writeMeta(base, meta) {
  writeFileSync(`${base}.meta.json.tmp`, JSON.stringify(meta, null, 2));
  renameSync(`${base}.meta.json.tmp`, `${base}.meta.json`);
}

// ---------- ingesting results

function enterStage(state, stage) {
  state.stage = stage;
  state.pending = "work";
  if (stage === "dev" || stage === "wiki") {
    state.stageBase[stage] = gitText("stash", "create") || gitText("rev-parse", "-q", "--verify", "HEAD") || EMPTY_TREE;
  }
}

function approve(state, stage, evidence) {
  state.approved[stage] = evidence;
  if (stage === "dev") state.devInput = null;
  enterStage(state, NEXT_STAGE[stage]);
}

const fileOf = (f) => (f.file ? String(f.file).replace(/:\d+.*$/, "") : null);
const tokens = (text) => new Set(slug(text).split("-").filter(Boolean));

// A finding's identity decides what counts as "the same topic". A criterion wins; otherwise
// file plus topic, where a slightly renamed topic on the same file (token Jaccard >= 0.5)
// is merged into the known identity.
function identityOf(f, known) {
  if (Number.isInteger(f.criterion)) return `criterion-${f.criterion}`;
  const file = fileOf(f);
  const mine = tokens(f.topic);
  for (const k of known) {
    if (Number.isInteger(k.criterion) || fileOf(k) !== file) continue;
    const theirs = tokens(k.topic);
    const shared = [...mine].filter((t) => theirs.has(t)).length;
    if (shared / (mine.size + theirs.size - shared) >= 0.5) return k.identity;
  }
  return file ? `${file}::${slug(f.topic)}` : slug(f.topic);
}

function block(state, kind, details) {
  state.blocked = { kind, since: now(), ...details };
}

function checkThresholds(state, stage) {
  const { topicRepeats, roundsPerStage } = state.assignment.limits;
  const repeated = Object.entries(state.counts[stage] ?? {}).find(([, n]) => n >= topicRepeats);
  if (repeated) {
    const [identity] = repeated;
    const occurrences = (state.findings[stage] ?? []).filter((f) => f.identity === identity);
    if ((state.ruled[stage] ?? []).includes(identity)) {
      return block(state, "user", { reason: "topic_repeated_after_ruling", resolveWith: "rule", stage, identity, occurrences });
    }
    return block(state, "ruling", { reason: "topic_repeated", stage, identity, occurrences });
  }
  const history = state.history[stage].slice(state.historyBase[stage] ?? 0);
  const last = history.slice(-3).map((h) => h.blocking);
  if (last.length === 3 && last[0] > 0 && last[2] >= last[1] && last[1] >= last[0]) {
    return block(state, "ruling", { reason: "stalled", stage, blockingPerRound: last });
  }
  if (state.round[stage] - (state.capBase[stage] ?? 0) >= roundsPerStage) {
    return block(state, "ruling", { reason: "round_cap", stage, rounds: state.round[stage] });
  }
}

function ingest(runDir, state, meta) {
  const call = state.inflight;
  state.inflight = null;
  const record = state.calls.findLast((c) => c.id === call.id);
  Object.assign(record, { status: meta.status, exitCode: meta.exitCode, sessionId: meta.sessionId, finished: meta.finished ?? now(), denials: meta.denials?.length ?? 0 });
  const base = callBase(runDir, call.id);

  if (meta.status === "guard_violation") return block(state, "user", { reason: "guard_violation", resolveWith: "retry", call: call.id, violations: meta.violations });
  if (meta.status === "usage_limit") return block(state, "user", { reason: "usage_limit", resolveWith: "retry", call: call.id, provider: call.provider, error: meta.error, log: `${base}.log` });
  if (meta.status !== "ok") {
    if (call.attempt < 2) {
      state.retryCall = { ...call, attempt: call.attempt + 1 };
      delete state.retryCall.provider;
      delete state.retryCall.started;
      return;
    }
    const reason = meta.status === "timeout" ? "call_timeout" : "call_failed";
    return block(state, "user", { reason, resolveWith: "retry", call: call.id, error: meta.error, log: `${base}.log` });
  }

  const stage = call.stage;
  if (call.mode === "work") {
    if (!existsSync(join(runDir, ARTIFACT[stage]))) {
      meta.status = "failed";
      meta.error = `${ARTIFACT[stage]} was not written`;
      state.inflight = call;
      return ingest(runDir, state, meta);
    }
    state.lastWork[stage] = { call: call.id, denials: meta.denials };
    state.pending = "review";
    state.denialStreak[stage] = meta.denials.length ? (state.denialStreak[stage] ?? 0) + 1 : 0;
    if (state.denialStreak[stage] >= 2) {
      block(state, "user", { reason: "repeated_permission_denials", resolveWith: "retry", call: call.id, denials: meta.denials });
    }
    return;
  }

  const outPath = `${base}.out.json`;
  const output = JSON.parse(readFileSync(outPath, "utf8"));

  if (call.mode === "qa") {
    state.lastQa = outPath;
    const dismissed = new Set(state.dismissed.dev ?? []);
    const failing = output.criteria.filter((c) => c.result === "FAIL" && !dismissed.has(`criterion-${c.id}`));
    if (failing.length === 0) return approve(state, "qa", outPath);
    // Back to dev. Keep the dev stage's diff base so the next review sees every change since dev began.
    state.approved.dev = null;
    state.devInput = "qa";
    state.stage = "dev";
    state.pending = "work";
    for (const c of failing) {
      const identity = `criterion-${c.id}`;
      state.counts.dev[identity] = (state.counts.dev[identity] ?? 0) + 1;
      state.findings.dev.push({ round: state.round.dev, call: call.id, identity, topic: identity, file: null, criterion: c.id, problem: `QA failed: ${c.criterion}`, required_change: c.reproduce ?? c.evidence });
    }
    return checkThresholds(state, "dev");
  }

  // review
  state.lastReview[stage] = outPath;
  if (stage === "dev") state.devInput = "review";
  const dismissed = new Set(state.dismissed[stage] ?? []);
  const findings = output.findings.map((f) => ({ ...f, identity: identityOf(f, state.findings[stage]) })).filter((f) => !dismissed.has(f.identity));
  const blocking = findings.filter((f) => f.severity === "blocking");
  for (const f of findings.filter((f) => f.severity === "nonblocking")) state.deferred.push({ stage, round: call.round, call: call.id, ...f });
  state.history[stage].push({ round: call.round, blocking: blocking.length });
  if (blocking.length === 0) return approve(state, stage, outPath);

  state.pending = "work";
  for (const f of blocking) state.findings[stage].push({ round: call.round, call: call.id, identity: f.identity, topic: f.topic, file: f.file, criterion: f.criterion, problem: f.problem, required_change: f.required_change });
  for (const identity of new Set(blocking.map((f) => f.identity))) state.counts[stage][identity] = (state.counts[stage][identity] ?? 0) + 1;
  checkThresholds(state, stage);
}

// ---------- actions shown to DENKEN

function actionFor(runDir, state) {
  if (state.stage === "done") {
    return { action: "done", run: relative(ROOT, runDir), approved: state.approved, deferred: state.deferred.length, rulings: state.rulings.length, crossProvider: state.assignment.crossProvider, warnings: state.assignment.warnings, next: "Write summary.md from state.json and report to the user." };
  }
  if (state.stage === "aborted") return { action: "aborted", run: relative(ROOT, runDir), rulings: state.rulings.length };
  if (state.blocked) {
    const b = state.blocked;
    if (b.kind === "ruling") {
      return { action: "needs_ruling", ...b, artifact: ARTIFACT[b.stage] ? join(runDir, ARTIFACT[b.stage]) : null, lastReview: state.lastReview[b.stage], next: "Decide, then run: rule <run> --decision <uphold|dismiss|replan|abort> --note <text>" };
    }
    return { action: "needs_user", ...b, next: b.resolveWith === "rule" ? "Ask the user, then record their decision with rule." : "Tell the user. When it is resolved, run retry (or rule --decision abort)." };
  }
  const c = state.inflight;
  if (c) return { action: "running", call: c.id, provider: c.provider, stage: c.stage, round: c.round, elapsedSec: Math.round((Date.now() - Date.parse(c.started)) / 1000), next: "Run next again with --wait." };
  return null;
}

async function next(runDir, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  for (;;) {
    const state = load(runDir);
    if (state.stage === "intake") fail("the run has not started; write brief.md, confirm it with the user, then run start");
    if (["done", "aborted"].includes(state.stage) || state.blocked) return print(actionFor(runDir, state));
    if (state.inflight) {
      // Wait on the call's own files only. state.json is not re-read until the call has
      // finished, because a misbehaving call may have it in a broken state until it is restored.
      const base = callBase(runDir, state.inflight.id);
      const pid = Number(existsSync(`${base}.pid`) ? readFileSync(`${base}.pid`, "utf8") : 0);
      const alive = () => {
        if (!pid || !pidAlive(pid)) return false;
        const age = Date.now() - Date.parse(state.inflight.started);
        return existsSync(`${base}.heartbeat`) ? Date.now() - statSync(`${base}.heartbeat`).mtimeMs < 60000 : age < 30000;
      };
      // Only this attempt's result counts. A result from an earlier attempt of the same call
      // (one judged dead that finished anyway) is set aside, not ingested.
      const readMeta = () => {
        if (!existsSync(`${base}.meta.json`)) return null;
        const meta = JSON.parse(readFileSync(`${base}.meta.json`, "utf8"));
        if (!state.inflight.nonce || meta.nonce === state.inflight.nonce) return meta;
        renameSync(`${base}.meta.json`, `${base}.stale-${Date.now()}.meta.json`);
        return null;
      };
      let meta = readMeta();
      while (!meta && alive() && Date.now() < deadline) {
        // Poll quickly at first, then back off to every 3 seconds for long calls.
        const age = Date.now() - Date.parse(state.inflight.started);
        await sleep(Math.min(Math.max(200, age / 10), 3000, Math.max(0, deadline - Date.now())));
        meta = readMeta();
      }
      if (!meta) {
        if (alive()) return print(actionFor(runDir, state));
        // The call's process died. Stop whatever its agent CLI left running before moving on.
        await stopCallGroup(base, state.inflight.provider);
        meta = { status: "failed", error: "the call process exited without writing a result", finished: now() };
      }
      assertLock();
      ingest(runDir, state, meta);
      save(runDir, state);
      continue;
    }
    assertLock();
    launch(runDir, state);
    if (Date.now() >= deadline) return print(actionFor(runDir, load(runDir)));
  }
}

// ---------- commands

function cmdNew(name) {
  if (!name) fail("usage: new <slug>");
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = join(DENKEN_DIR, "runs", `${stamp}-${slug(name)}`);
  if (existsSync(dir)) fail(`run already exists: ${relative(ROOT, dir)}`);
  mkdirSync(join(dir, "calls"), { recursive: true });
  const ignore = join(DENKEN_DIR, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "runs/\nconfig.local.json\n");
  save(dir, { version: 1, task: name, created: now(), stage: "intake" });
  print({ action: "created", run: relative(ROOT, dir), next: `Write ${relative(ROOT, join(dir, "brief.md"))}, confirm it with the user, then run start.` });
}

function cmdStart(runDir) {
  const state = load(runDir);
  if (state.stage !== "intake") fail(`run already started (stage: ${state.stage})`);
  const brief = join(runDir, "brief.md");
  if (!existsSync(brief) || !readFileSync(brief, "utf8").trim()) fail("brief.md is missing or empty");
  if (spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: ROOT }).status !== 0) fail("DENKEN needs a git work tree to detect file changes; run git init first");
  const config = resolveConfig(ROOT);
  if (config.errors.length) {
    print({ action: "needs_user", reason: "config", errors: config.errors, warnings: config.warnings, next: "Fix the configuration with config.mjs, then run start again." });
    process.exit(1);
  }
  if (config.sameReviewer.length && !config.allowSameReviewer) {
    print({ action: "needs_user", reason: "same_reviewer", stages: config.sameReviewer, next: "The same model would check its own work. Ask the user: set a different richter/genau model or effort with config.mjs, or set allowSameReviewer true. Then run start again." });
    process.exit(1);
  }
  Object.assign(state, {
    assignment: { crossProvider: config.crossProvider, sameReviewer: config.sameReviewer, stages: config.stages, limits: config.limits, warnings: config.warnings },
    baseRef: gitText("rev-parse", "-q", "--verify", "HEAD") || null,
    round: { plan: 0, dev: 0, qa: 0, wiki: 0 },
    stageBase: {},
    counts: { plan: {}, dev: {}, wiki: {} },
    findings: { plan: [], dev: [], wiki: [] },
    history: { plan: [], dev: [], wiki: [] },
    historyBase: {},
    capBase: {},
    dismissed: {},
    ruled: {},
    denialStreak: {},
    lastReview: {},
    lastWork: {},
    lastQa: null,
    devInput: null,
    deferred: [],
    rulings: [],
    approved: { plan: null, dev: null, qa: null, wiki: null },
    calls: [],
    inflight: null,
    blocked: null,
    retryCall: null,
  });
  enterStage(state, "plan");
  assertLock();
  save(runDir, state);
  print({ action: "started", run: relative(ROOT, runDir), crossProvider: config.crossProvider, stages: config.stages, limits: config.limits, warnings: config.warnings, next: "Run next with --wait." });
}

function cmdRule(runDir, args) {
  const state = load(runDir);
  if (!state.blocked) fail("nothing to rule on: the run is not blocked");
  const decision = args[args.indexOf("--decision") + 1];
  if (!["uphold", "dismiss", "replan", "abort"].includes(decision)) fail("--decision must be uphold, dismiss, replan or abort");
  const noteIndex = args.indexOf("--note");
  const fileIndex = args.indexOf("--note-file");
  const note = noteIndex >= 0 ? args[noteIndex + 1] : fileIndex >= 0 ? readFileSync(args[fileIndex + 1], "utf8") : null;
  if (!note?.trim()) fail("a ruling needs --note <text> or --note-file <path> explaining the decision and the direction");

  const b = state.blocked;
  const stage = b.stage ?? state.stage;
  // Dismissals are per finding: a stage-wide ruling must name each identity it dismisses.
  const open = new Set(state.findings[stage]?.filter((f) => f.round === state.round[stage]).map((f) => f.identity));
  const listIndex = args.indexOf("--identities");
  const listed = listIndex >= 0 ? String(args[listIndex + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const targets = [...new Set([...(b.identity ? [b.identity] : []), ...listed])];
  if (decision === "dismiss") {
    if (targets.length === 0) fail(`name the findings to dismiss with --identities <a,b>. Open: ${[...open].join(", ") || "none"}`);
    const unknown = targets.filter((t) => t !== b.identity && !open.has(t));
    if (unknown.length) fail(`not open in this stage: ${unknown.join(", ")}. Open: ${[...open].join(", ")}`);
  }
  const id = `R${state.rulings.length + 1}`;
  const subject = decision === "dismiss" ? targets.join(", ") : b.identity ?? b.reason;
  assertLock();
  state.rulings.push({ id, stage, subject, reason: b.reason, decision, at: now() });
  appendFileSync(join(runDir, "rulings.md"), `${state.rulings.length === 1 ? "# Rulings\n\n" : ""}## ${id} · ${stage} · ${subject} · ${decision}\n\n${note.trim()}\n\n`);
  state.blocked = null;
  state.capBase[stage] = state.round[stage];
  state.historyBase[stage] = state.history[stage]?.length ?? 0;
  if (b.identity) {
    state.counts[stage][b.identity] = 0;
    (state.ruled[stage] ??= []).push(b.identity);
  }

  if (decision === "abort") state.stage = "aborted";
  else if (decision === "replan") {
    for (const s of ["plan", "dev", "qa", "wiki"]) state.approved[s] = null;
    state.devInput = null;
    enterStage(state, "plan");
  } else if (decision === "dismiss") {
    (state.dismissed[stage] ??= []).push(...targets);
    for (const t of targets) state.counts[stage][t] = 0;
    // Approve only when nothing blocking remains open after the dismissal. The dismissed
    // findings are kept, marked as such, for the summary.
    const dismissed = new Set(state.dismissed[stage]);
    const lastRound = state.findings[stage].filter((f) => f.round === state.round[stage]);
    if (lastRound.every((f) => dismissed.has(f.identity)) && state.lastReview[stage]) {
      for (const f of lastRound) state.deferred.push({ stage, round: f.round, call: f.call, ...f, severity: "dismissed" });
      approve(state, stage, `${state.lastReview[stage]} + ruling ${id}`);
    }
  }
  assertLock();
  save(runDir, state);
  print({ action: "ruled", id, decision, stage: state.stage, next: state.stage === "aborted" ? "Tell the user the run was aborted." : "Run next with --wait." });
}

function cmdRetry(runDir) {
  const state = load(runDir);
  const b = state.blocked;
  if (!b || b.kind !== "user") fail("nothing to retry: the run is not waiting on the user");
  if (b.resolveWith === "rule") fail("this block needs a decision: use rule");
  state.blocked = null;
  if (b.reason !== "repeated_permission_denials") {
    const last = state.calls.findLast((c) => c.id === b.call);
    const [stage, role, round] = b.call.split("-");
    state.retryCall = { stage, role, mode: last.mode, round: Number(round), attempt: 1 };
    if (last.mode === "work") state.pending = "work";
  } else {
    state.denialStreak[state.stage] = 0;
  }
  assertLock();
  save(runDir, state);
  print({ action: "resumed", next: "Run next with --wait." });
}

// The last thing a running call did, read from the tail of its streamed log.
function lastActivity(logPath) {
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

// One engine process per run. Claude Code moves a slow command to the background instead of
// killing it, so without a lock two `next` processes could ingest or launch the same call.
// The lock is a directory (mkdir is atomic), refreshed by a heartbeat. A lock whose heartbeat
// is older than LOCK_STALE_MS is stale no matter what its pid is, so a reused pid cannot keep
// a dead run busy. A stale lock is taken over by renaming it away, which only one process can do.
const LOCK_STALE_MS = 30000;
const lock = { dir: null, nonce: null };

function holdsLock() {
  try {
    return JSON.parse(readFileSync(join(lock.dir, "owner"), "utf8")).nonce === lock.nonce;
  } catch {
    return false;
  }
}

function assertLock() {
  if (!holdsLock()) fail("this engine process lost the run lock (another process took the run over); stopping without changing anything");
}

async function acquireLock(runDir, waitMs) {
  const dir = `${runDir}.lock`;
  const deadline = Date.now() + waitMs;
  const nonce = randomUUID();
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "owner"), JSON.stringify({ pid: process.pid, nonce, since: now() }));
      Object.assign(lock, { dir, nonce });
      setInterval(() => {
        try {
          const t = new Date();
          utimesSync(dir, t, t);
        } catch {}
      }, 5000).unref();
      const release = () => holdsLock() && rmSync(dir, { recursive: true, force: true });
      process.on("exit", release);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => {
          release();
          process.exit(128);
        });
      }
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let stale;
    try {
      const age = Date.now() - statSync(dir).mtimeMs;
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(join(dir, "owner"), "utf8"));
      } catch {}
      // No owner file yet means another process is between mkdir and writing it.
      stale = age > LOCK_STALE_MS || (owner ? !pidAlive(owner.pid) : age > 2000);
    } catch {
      continue;
    }
    if (stale) {
      const grave = `${dir}.stale-${randomUUID()}`;
      try {
        renameSync(dir, grave);
        rmSync(grave, { recursive: true, force: true });
      } catch {}
      continue;
    }
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

function cmdStatus(runDir) {
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
  });
}

const [command, runArg, ...rest] = process.argv.slice(2);
const locked = async (fn) => {
  const runDir = runDirOf(runArg);
  if (!(await acquireLock(runDir, 0))) fail("another DENKEN engine process is working on this run; wait for it, then try again");
  fn(runDir);
};
switch (command) {
  case "new":
    cmdNew(runArg);
    break;
  case "start":
    await locked(cmdStart);
    break;
  case "next": {
    const i = rest.indexOf("--wait");
    const waitSec = i >= 0 ? Number(rest[i + 1]) || 0 : 0;
    const runDir = runDirOf(runArg);
    if (!(await acquireLock(runDir, waitSec * 1000))) {
      print({ action: "running", busy: true, next: "Another DENKEN engine process is waiting on this run. Run next again with --wait." });
      break;
    }
    await next(runDir, waitSec);
    break;
  }
  case "rule":
    await locked((runDir) => cmdRule(runDir, rest));
    break;
  case "retry":
    await locked(cmdRetry);
    break;
  case "status":
    cmdStatus(runDirOf(runArg));
    break;
  case "_exec":
    try {
      await execCall(runArg, rest[0]);
    } catch (e) {
      const base = callBase(runArg, rest[0]);
      let nonce = null;
      try {
        nonce = JSON.parse(readFileSync(`${base}.job.json`, "utf8")).nonce;
      } catch {}
      writeMeta(base, { status: "failed", nonce, error: `runner error: ${e.message}`, finished: now() });
    }
    break;
  default:
    fail("usage: denken.mjs <new|start|next|rule|retry|status> ...");
}
