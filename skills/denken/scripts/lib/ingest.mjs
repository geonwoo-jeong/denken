// Taking in a finished call's result. The prelude is the same for every call: record it, note its
// seed and session, and stop on a violation, a permission request or a failure. Then the result
// goes to the handler for the call's kind: work, review or QA.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACTS, now, oneLine, PERMISSION_ASKS_PER_ROLE, PERMISSION_ATTEMPTS_PER_CALL, sha } from "./core.mjs";
import { ingestQa } from "./ingest-qa.mjs";
import { ingestReview } from "./ingest-review.mjs";
import { ingestWork } from "./ingest-work.mjs";
import { agentFor, agentLabel, roleAgents } from "./levels.mjs";
import { logRaw, timeline } from "./record.mjs";
import { profileOf } from "./seeds.mjs";
import { block, callBase, readRunFile } from "./state.mjs";

export function ingest(runDir, state, meta) {
  const call = state.inflight;
  state.inflight = null;
  const record = state.calls.findLast((c) => c.id === call.id);
  const who = call.role.toUpperCase();
  logRaw(state, runDir, call.id);
  noteSeed(state, call, meta);
  if (meta.continue?.fallback) timeline(state, "ENGINE", `${who} could not continue its session, and started fresh: ${oneLine(meta.continue.fallback, 200)}`);
  // A worker that wrote none of its report failed, whatever its CLI said.
  const missing = call.mode === "work" && meta.status === "ok" ? ARTIFACTS[call.stage].filter((f) => !existsSync(join(runDir, f))) : [];
  if (missing.length) Object.assign(meta, { status: "failed", error: `${missing.join(", ")} was not written` });
  Object.assign(record, { status: meta.status, exitCode: meta.exitCode, sessionId: meta.sessionId, finished: meta.finished ?? now(), denials: meta.denials?.length ?? 0 });
  if (meta.status !== "ok") timeline(state, who, `${meta.status}${meta.error ? `: ${oneLine(meta.error)}` : ""}${meta.violations?.length ? `: ${meta.violations.join("; ")}` : ""}`);
  if (stopsHere(runDir, state, call, meta)) return;

  noteSession(state, call, meta);
  if (call.mode === "work") return ingestWork(runDir, state, call, meta);
  const outPath = `${callBase(runDir, call.id)}.out.json`;
  const output = JSON.parse(readFileSync(outPath, "utf8"));
  if (ranAsItsWorker(state, call, meta)) return;
  return call.mode === "qa" ? ingestQa(runDir, state, call, meta, output, outPath) : ingestReview(runDir, state, call, meta, output, outPath);
}

// FLAMME's seed for the call's kind, made by this call or used by it.
function noteSeed(state, call, meta) {
  if (!meta.seed) return;
  const kind = meta.seed.key.split("#")[0];
  const t = meta.seed.facts?.tokens;
  if (!meta.seed.fallback && meta.seed.sessionId) {
    const known = (state.seedSessions ??= {})[meta.seed.key];
    state.seedSessions[meta.seed.key] = { ...(known ?? { perspective: kind, stage: call.stage, provider: call.provider, call: call.id, at: now() }), sessionId: meta.seed.sessionId, lastUsedAt: now() };
    if (meta.seed.rewarmed) timeline(state, `FLAMME (${call.provider})`, `re-warmed the ${kind} seed, idle for close to an hour, before ${call.id} forked it`);
  }
  if (meta.seed.created && !meta.seed.fallback) {
    timeline(state, `FLAMME (${call.provider})`, `seeded the ${kind} context in the ${call.stage} stage, for ${call.id}${t ? ` (in ${t.input ?? "?"} · cache read ${t.cacheRead ?? "?"} · out ${t.output ?? "?"})` : ""}; calls with the same perspective and settings fork it`);
  }
  if (meta.seed.fallback) {
    delete state.seedSessions?.[meta.seed.key];
    timeline(state, "ENGINE", `${call.role.toUpperCase()} ran without FLAMME's seed: ${oneLine(meta.seed.fallback, 200)}`);
  }
}

// A successful worker's session, for its next round to continue.
function noteSession(state, call, meta) {
  if (call.mode !== "work" || !meta.sessionId) return;
  const continued = meta.continue && !meta.continue.fallback;
  (state.workSessions ??= {})[call.role] = { sessionId: meta.sessionId, call: call.id, stage: call.stage, epoch: state.seedEpoch ?? 0, profile: sha(JSON.stringify(profileOf(state, call, agentFor(state, call)))), chain: continued ? meta.continue.chain : 1, at: now() };
}

// Whether the run stops or retries before the result is looked at: a guard violation, a permission
// request, a usage limit, or a failed call (retried once).
function stopsHere(runDir, state, call, meta) {
  const base = callBase(runDir, call.id);
  if (meta.status === "guard_violation") {
    block(state, "user", { reason: "guard_violation", resolveWith: "retry", call: call.id, violations: meta.violations });
    return true;
  }
  if (askedForPermission(runDir, state, call, meta)) return true;
  if (meta.status === "usage_limit") {
    block(state, "user", { reason: "usage_limit", resolveWith: "retry", call: call.id, provider: call.provider, error: meta.error, log: `${base}.log` });
    return true;
  }
  if (meta.status === "ok") return false;
  if (call.attempt < 2) {
    state.retryCall = { ...call, attempt: call.attempt + 1 };
    delete state.retryCall.provider;
    delete state.retryCall.started;
    return true;
  }
  block(state, "user", { reason: meta.status === "timeout" ? "call_timeout" : "call_failed", resolveWith: "retry", call: call.id, error: meta.error, log: `${base}.log` });
  return true;
}

// A worker that asked for a permission stops here, whatever it produced: only DENKEN may widen what a
// role can do, and the call runs again once DENKEN has decided.
function askedForPermission(runDir, state, call, meta) {
  const who = call.role.toUpperCase();
  const requests = readRunFile(runDir, `calls/${call.id}.permission.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.attempt === call.attempt);
  for (const r of requests) timeline(state, who, `asked for permission: ${r.need} (${r.why})`);
  if (!requests.length) return false;
  // Requests are capped, and a need DENKEN already denied for this role is denied again without
  // stopping the run, so a worker cannot stall it by asking over and over.
  const asks = ((state.permissionAsks ??= {})[call.role] = (state.permissionAsks[call.role] ?? 0) + 1);
  const denied = new Set((state.permissionDecisions ?? []).filter((d) => d.role === call.role && d.decision === "deny").flatMap((d) => d.requests.map((r) => r.need)));
  if (asks > PERMISSION_ASKS_PER_ROLE || call.attempt >= PERMISSION_ATTEMPTS_PER_CALL) {
    block(state, "permission", { reason: "permission_loop", resolveWith: "grant", userRequired: true, call: call.id, callInfo: call, role: call.role, provider: call.provider, requests, asks, limit: { perRole: PERMISSION_ASKS_PER_ROLE, attemptsPerCall: PERMISSION_ATTEMPTS_PER_CALL }, denials: meta.denials ?? [] });
    return true;
  }
  if (requests.every((r) => denied.has(r.need))) {
    const id = `P${(state.permissionDecisions ?? []).length + 1}`;
    const note = `Asked again for ${requests.map((r) => r.need).join(", ")}, which DENKEN already denied for this role. It stays denied: do the work without it, or report the item blocked.`;
    (state.permissionDecisions ??= []).push({ id, call: call.id, role: call.role, decision: "deny", by: "engine", what: requests.map((r) => r.need).join(", "), note, requests, at: now() });
    appendFileSync(join(runDir, "rulings.md"), `${existsSync(join(runDir, "rulings.md")) ? "" : "# Rulings\n\n"}## ${id} · permission · ${who} · denied again (engine)\n\n${note}\n\n`);
    timeline(state, "ENGINE", `${id}: ${who} asked again for ${requests.map((r) => r.need).join(", ")}, already denied → denied again, ${call.id} runs again`);
    state.retryCall = { stage: call.stage, role: call.role, mode: call.mode, round: call.round, attempt: call.attempt + 1 };
    if (call.mode === "work") state.pending = "work";
    return true;
  }
  block(state, "permission", { reason: "needs_permission", resolveWith: "grant", call: call.id, callInfo: call, role: call.role, provider: call.provider, requests, denials: meta.denials ?? [] });
  return true;
}

// What actually ran can differ from what was asked for (an alias, an allowlist substituting a
// model). A checker that ran as the same model and effort as the worker it checks is not accepted
// as a check.
function ranAsItsWorker(state, call, meta) {
  const worker = call.mode === "qa" ? state.lastWork.dev : state.lastWork[call.stage];
  const ran = meta.facts?.modelRan;
  if (state.assignment.allowSameReviewer || !ran || worker?.modelRan !== ran || worker.provider !== call.provider || (worker.effort ?? null) !== (meta.facts.effort ?? null)) return false;
  timeline(state, "ENGINE", `${call.role.toUpperCase()} ran as ${ran}, the same model and effort as the work it checks (${worker.call}); its result is not used`);
  block(state, "user", { reason: "same_model_ran", resolveWith: "retry", call: call.id, checked: worker.call, model: ran, effort: meta.facts.effort ?? null, role: call.role, ranAs: agentLabel(roleAgents(state)[call.role]) });
  return true;
}
