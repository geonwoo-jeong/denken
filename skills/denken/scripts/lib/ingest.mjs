// Taking in a finished call's result: ticks, gaps, reviews, QA reports and recovery TODOs.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changeTree } from "./changes.mjs";
import { ARTIFACTS, now, oneLine, PERMISSION_ASKS_PER_ROLE, PERMISSION_ATTEMPTS_PER_CALL, sha, TODO_DEV, TODO_FIX, TODO_QA } from "./core.mjs";
import { checkThresholds, identityOf, recordReview } from "./findings.mjs";
import { agentFor, agentLabel, roleAgents } from "./levels.mjs";
import { logPart, logQa, logRaw, logStep, STAGE_LOG, STAGE_NAME, timeline, verdict } from "./record.mjs";
import { factsBrief, renderFacts, renderFindings, renderWork } from "./render.mjs";
import { profileOf } from "./seeds.mjs";
import { approve } from "./stages.mjs";
import { block, callBase, readRunFile } from "./state.mjs";
import { applyTicks, devGaps, setTick } from "./ticks.mjs";
import { blockedIn, fixItems, parseItems, todoGaps } from "./todo.mjs";
import { unitPlanGaps, unitScopeGaps } from "./units.mjs";
import { wikiGaps } from "./wiki.mjs";

export function ingest(runDir, state, meta) {
  const call = state.inflight;
  state.inflight = null;
  const record = state.calls.findLast((c) => c.id === call.id);
  Object.assign(record, { status: meta.status, exitCode: meta.exitCode, sessionId: meta.sessionId, finished: meta.finished ?? now(), denials: meta.denials?.length ?? 0 });
  const base = callBase(runDir, call.id);
  const who = call.role.toUpperCase();
  logRaw(state, runDir, call.id);
  // FLAMME's seed for the role, made by this call or used by it.
  if (meta.seed) {
    const t = meta.seed.facts?.tokens;
    if (!meta.seed.fallback && meta.seed.sessionId) {
      const known = (state.seedSessions ??= {})[meta.seed.key];
      state.seedSessions[meta.seed.key] = { ...(known ?? { perspective: meta.seed.key.split("#")[0], stage: call.stage, provider: call.provider, call: call.id, at: now() }), sessionId: meta.seed.sessionId, lastUsedAt: now() };
      if (meta.seed.rewarmed) timeline(state, `FLAMME (${call.provider})`, `re-warmed the ${meta.seed.key.split("#")[0]} seed, idle for close to an hour, before ${call.id} forked it`);
    }
    if (meta.seed.created && !meta.seed.fallback) {
      timeline(state, `FLAMME (${call.provider})`, `seeded the ${meta.seed.key.split("#")[0]} context in the ${call.stage} stage, for ${call.id}${t ? ` (in ${t.input ?? "?"} · cache read ${t.cacheRead ?? "?"} · out ${t.output ?? "?"})` : ""}; calls with the same perspective and settings fork it`);
    }
    if (meta.seed.fallback) {
      delete state.seedSessions?.[meta.seed.key];
      timeline(state, "ENGINE", `${who} ran without FLAMME's seed: ${oneLine(meta.seed.fallback, 200)}`);
    }
  }
  // The worker's session, for its next round to continue.
  if (meta.continue?.fallback) timeline(state, "ENGINE", `${who} could not continue its session, and started fresh: ${oneLine(meta.continue.fallback, 200)}`);
  if (call.mode === "work" && meta.status === "ok" && meta.sessionId) {
    const continued = meta.continue && !meta.continue.fallback;
    (state.workSessions ??= {})[call.role] = { sessionId: meta.sessionId, call: call.id, stage: call.stage, epoch: state.seedEpoch ?? 0, profile: sha(JSON.stringify(profileOf(state, call, agentFor(state, call)))), chain: continued ? meta.continue.chain : 1, at: now() };
  }
  if (meta.status !== "ok") timeline(state, who, `${meta.status}${meta.error ? `: ${oneLine(meta.error)}` : ""}${meta.violations?.length ? `: ${meta.violations.join("; ")}` : ""}`);

  if (meta.status === "guard_violation") return block(state, "user", { reason: "guard_violation", resolveWith: "retry", call: call.id, violations: meta.violations });
  // A worker that asked for a permission stops here, whatever it produced: only DENKEN may widen
  // what a role can do, and the call runs again once DENKEN has decided.
  const requests = readRunFile(runDir, `calls/${call.id}.permission.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.attempt === call.attempt);
  for (const r of requests) timeline(state, who, `asked for permission: ${r.need} (${r.why})`);
  if (requests.length) {
    // Requests are capped, and a need DENKEN already denied for this role is denied again
    // without stopping the run, so a worker cannot stall it by asking over and over.
    const asks = ((state.permissionAsks ??= {})[call.role] = (state.permissionAsks[call.role] ?? 0) + 1);
    const denied = new Set((state.permissionDecisions ?? []).filter((d) => d.role === call.role && d.decision === "deny").flatMap((d) => d.requests.map((r) => r.need)));
    if (asks > PERMISSION_ASKS_PER_ROLE || call.attempt >= PERMISSION_ATTEMPTS_PER_CALL) {
      return block(state, "permission", { reason: "permission_loop", resolveWith: "grant", userRequired: true, call: call.id, callInfo: call, role: call.role, provider: call.provider, requests, asks, limit: { perRole: PERMISSION_ASKS_PER_ROLE, attemptsPerCall: PERMISSION_ATTEMPTS_PER_CALL }, denials: meta.denials ?? [] });
    }
    if (requests.every((r) => denied.has(r.need))) {
      const id = `P${(state.permissionDecisions ?? []).length + 1}`;
      const note = `Asked again for ${requests.map((r) => r.need).join(", ")}, which DENKEN already denied for this role. It stays denied: do the work without it, or report the item blocked.`;
      (state.permissionDecisions ??= []).push({ id, call: call.id, role: call.role, decision: "deny", by: "engine", what: requests.map((r) => r.need).join(", "), note, requests, at: now() });
      appendFileSync(join(runDir, "rulings.md"), `${existsSync(join(runDir, "rulings.md")) ? "" : "# Rulings\n\n"}## ${id} · permission · ${who} · denied again (engine)\n\n${note}\n\n`);
      timeline(state, "ENGINE", `${id}: ${who} asked again for ${requests.map((r) => r.need).join(", ")}, already denied → denied again, ${call.id} runs again`);
      state.retryCall = { stage: call.stage, role: call.role, mode: call.mode, round: call.round, attempt: call.attempt + 1 };
      if (call.mode === "work") state.pending = "work";
      return;
    }
    return block(state, "permission", { reason: "needs_permission", resolveWith: "grant", call: call.id, callInfo: call, role: call.role, provider: call.provider, requests, denials: meta.denials ?? [] });
  }
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
    const missing = ARTIFACTS[stage].filter((f) => !existsSync(join(runDir, f)));
    if (missing.length) {
      meta.status = "failed";
      meta.error = `${missing.join(", ")} was not written`;
      state.inflight = call;
      return ingest(runDir, state, meta);
    }
    state.lastWork[stage] = { call: call.id, denials: meta.denials, provider: call.provider, modelRan: meta.facts?.modelRan ?? null, effort: meta.facts?.effort ?? null };
    state.pending = "review";
    let rejectedTicks = [];
    if (stage === "dev") {
      const { applied, rejected } = applyTicks(runDir, state, call);
      rejectedTicks = rejected;
      if (applied.length) timeline(state, who, `ticked ${applied.map((e) => e.item).join(", ")}, each with its test run and evidence`);
      if (rejected.length) timeline(state, "ENGINE", `tick record(s) not accepted: ${rejected.map((r) => `${r.item} (${r.problem})`).join("; ")}`);
    }
    const step = logStep(state, stage, `${call.role}-round${call.round}`, renderWork(runDir, state, call, call.provider, meta.facts));
    verdict(state, `${STAGE_NAME[stage]}${stage === "dev" && state.devInput === "qa" ? " (QA fix)" : ""}, round ${call.round}`, `${who} (${call.provider})`, "READY", readRunFile(runDir, `calls/${call.id}.out.md`), { call: call.id, file: step });
    timeline(state, who, `finished ${stage} round ${call.round}${factsBrief(meta.facts)}: ${oneLine(readRunFile(runDir, `calls/${call.id}.out.md`), 160)} → ${step}`);
    // Deterministic checks run before the reviewer: TODO lists with coverage gaps go straight
    // back to METHODE, and DEV items STARK neither ticked off nor reported blocked go straight
    // back to STARK, as an engine round, without spending a review on them.
    if (stage === "plan" || stage === "dev" || stage === "wiki") {
      const gaps = stage === "plan" ? [...todoGaps(runDir), ...unitPlanGaps(runDir, state)] : stage === "dev" ? [...devGaps(runDir, state, rejectedTicks), ...unitScopeGaps(state)] : wikiGaps(state);
      if (gaps.length) {
        const gapsPath = `${base}.gaps.json`;
        const checked = { plan: "engine check of the TODO lists against request.md", dev: "engine check of the TODO items' ticks and recorded test runs", wiki: "engine check that only documentation changed" }[stage];
        writeFileSync(gapsPath, JSON.stringify({ verdict: "CHANGES_REQUESTED", findings: gaps, checked: [checked] }, null, 2));
        state.lastReview[stage] = gapsPath;
        if (stage === "dev") state.devInput = "review";
        const file = logStep(state, stage, `engine-check-round${call.round}`, renderFindings(`ENGINE · ${checked}`, { findings: gaps, checked: [checked] }));
        timeline(state, "ENGINE", `${gaps.length} problem(s) found by the engine → back to ${who} without a review: ${oneLine(gaps[0].problem, 120)} → ${file}`);
        verdict(state, `${STAGE_NAME[stage]} check, round ${call.round}`, "ENGINE", "RETURNED", gaps.map((g) => g.problem).join("; "), { call: call.id, file });
        recordReview(state, stage, call, gaps);
        return;
      }
    }
    // A recovery item STARK reports blocked needs a decision above STARK's head.
    if (stage === "dev" && state.devInput === "qa") {
      const report = readRunFile(runDir, "dev-report.md");
      const stuck = fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle && !f.done && blockedIn(report, f.key));
      if (stuck.length) {
        timeline(state, who, `reported recovery item(s) blocked: ${stuck.map((f) => f.key).join(", ")}`);
        return block(state, "ruling", { reason: "fix_blocked", stage: "dev", items: stuck.map((f) => ({ item: f.key, text: f.text, report: report.split("\n").find((l) => blockedIn(l, f.key))?.trim() ?? "" })), rule: "a recovery item reported blocked" });
      }
    }
    state.denialStreak[stage] = meta.denials.length ? (state.denialStreak[stage] ?? 0) + 1 : 0;
    if (state.denialStreak[stage] >= 2) {
      block(state, "permission", { reason: "repeated_permission_denials", resolveWith: "grant", call: call.id, callInfo: call, role: call.role, provider: call.provider, requests: [], denials: meta.denials });
    }
    return;
  }

  const outPath = `${base}.out.json`;
  const output = JSON.parse(readFileSync(outPath, "utf8"));

  // What actually ran can differ from what was asked for (an alias, an allowlist substituting a
  // model). A checker that ran as the same model and effort as the worker it checks is not
  // accepted as a check.
  const worker = call.mode === "qa" ? state.lastWork.dev : state.lastWork[stage];
  const ran = meta.facts?.modelRan;
  if (!state.assignment.allowSameReviewer && ran && worker?.modelRan === ran && worker.provider === call.provider && (worker.effort ?? null) === (meta.facts.effort ?? null)) {
    timeline(state, "ENGINE", `${who} ran as ${ran}, the same model and effort as the work it checks (${worker.call}); its result is not used`);
    return block(state, "user", { reason: "same_model_ran", resolveWith: "retry", call: call.id, checked: worker.call, model: ran, effort: meta.facts.effort ?? null, role: call.role, ranAs: agentLabel(roleAgents(state)[call.role]) });
  }

  if (call.mode === "qa") {
    state.lastQa = outPath;
    // Every QA item must be reported; one that is missing counts as failed.
    const qaItems = parseItems(readRunFile(runDir, TODO_QA), "QA").items;
    const refsOf = new Map(qaItems.map((q) => [q.key, q.refs]));
    const reported = new Map(output.items.map((c) => [c.id, c]));
    const items = [...output.items];
    for (const q of qaItems) {
      if (!reported.has(q.key)) items.push({ id: q.key, request_item: q.refs.find((r) => r.startsWith("REQ-")) ?? null, check: q.text, how_verified: "", result: "FAIL", evidence: "missing from the QA report", reproduce: null, evidence_files: [] });
    }
    const reqOf = (c) => (typeof c.request_item === "string" && /^REQ-\d{3,}$/.test(c.request_item) ? [c.request_item] : (refsOf.get(c.id) ?? []).filter((r) => r.startsWith("REQ-")));
    const identity = (c) => reqOf(c)[0] ?? c.id;
    const dismissed = new Set(state.dismissed.dev ?? []);
    const failing = items.filter((c) => c.result === "FAIL" && !dismissed.has(identity(c)));
    // The QA list records what was verified: each checked item is ticked with GENAU's evidence.
    for (const c of items) setTick(runDir, "QA", c.id, c.result === "PASS", c.result === "PASS" ? `${c.evidence} (verified by: ${c.how_verified ? `${c.how_verified}; ` : ""}${call.id})` : null);
    logQa(state, runDir, call, items, meta.facts);
    const summary = output.summary ?? (failing.length ? failing.map((c) => `${c.id} failed`).join(", ") : "all checks passed");
    const agreed = (output.result === "PASS") === !failing.length;
    verdict(state, `Independent QA${state.units ? " after the merge" : ""}, cycle ${call.round}`, `GENAU (${call.provider})`, failing.length ? "FAILED" : "PASSED", summary, { call: call.id, file: `${logPart(state, STAGE_LOG.qa)}/qa-${call.round}/report.md`, note: agreed ? null : `GENAU's result: ${output.result}; ${failing.length} failing item(s) after dismissals and missing items` });
    timeline(state, who, failing.length ? `FAILED QA cycle ${call.round}: ${failing.map((c) => c.id).join(", ")} → ${logPart(state, STAGE_LOG.qa)}/qa-${call.round}/` : `PASSED QA cycle ${call.round} (${items.length} checks) → ${logPart(state, STAGE_LOG.qa)}/qa-${call.round}/`);
    if (failing.length === 0) return approve(state, "qa", outPath);
    // Back to dev with a recovery TODO the engine writes from the QA evidence: STARK sees what
    // broke and how to reproduce it, not the QA TODO list. The dev stage's diff base is kept, so
    // the next review sees every change since development began.
    const cycle = state.round.qa;
    const first = (state.fixCount ?? 0) + 1;
    const keys = failing.map((_, i) => `FIX-${String(first + i).padStart(3, "0")}`);
    const lines = failing.map((c, i) => `- [ ] ${keys[i]} (${[c.id, ...reqOf(c)].join(", ")}) Fix: ${oneLine(c.check, 400)}. Observed: ${oneLine(c.evidence, 400)}.${c.reproduce ? ` Reproduce: ${oneLine(c.reproduce, 400)}.` : ""}`);
    const header = existsSync(join(runDir, TODO_FIX)) ? "" : "# Recovery TODO\n\nWritten by the engine from failed QA checks. Fix the cause of each item in general, then tick it off with the tick command and its evidence.\n";
    appendFileSync(join(runDir, TODO_FIX), `${header}\n## QA cycle ${cycle}\n\n${lines.join("\n")}\n`);
    state.fixCount = first + failing.length - 1;
    (state.fixCycles ??= {})[cycle] = { at: now(), items: keys, qa: call.id, tree: changeTree(state) };
    state.currentFixCycle = cycle;
    const recovery = logStep(state, "dev", `engine-recovery-todo-qa${cycle}`, `# Recovery TODO · QA cycle ${cycle}\n\nWritten by the engine from GENAU's failed checks; STARK fixes these, UBEL approves, then QA runs again.\n\n${lines.join("\n")}\n`);
    verdict(state, `Recovery, QA cycle ${cycle}`, "ENGINE", "RETURNED", `${keys.join(", ")} written from the failed checks, back to STARK`, { file: recovery });
    timeline(state, "ENGINE", `recovery TODO ${keys.join(", ")} written from the QA failures → back to STARK → ${recovery}`);
    // The checkboxes must stay truthful: DEV items serving a failing REQ item are unticked, and
    // need fresh evidence and a passing test run to be ticked again.
    const failingReq = new Set(failing.flatMap(reqOf));
    for (const d of parseItems(readRunFile(runDir, TODO_DEV), "DEV").items) {
      if (d.done && d.refs.some((r) => failingReq.has(r)) && setTick(runDir, "DEV", d.key, false)) {
        (state.unticked ??= {})[d.key] = { at: now(), cycle, tree: changeTree(state) };
      }
    }
    state.approved.dev = null;
    state.devInput = "qa";
    state.stage = "dev";
    state.pending = "work";
    // The engine can write a recovery TODO, but it cannot find a root cause. The same failure in
    // two QA cycles in a row goes to DENKEN instead of producing yet another FIX item.
    const repeated = failing.map(identity).filter((id) => (state.lastQaFailing ?? []).includes(id));
    state.lastQaFailing = failing.map(identity);
    for (const c of failing) {
      const id = identity(c);
      state.counts.dev[id] = (state.counts.dev[id] ?? 0) + 1;
      state.findings.dev.push({ round: state.round.dev, call: call.id, identity: id, topic: id, file: null, request_item: reqOf(c)[0] ?? null, todo: c.id, problem: `QA failed ${c.id}: ${c.check ?? ""}`, required_change: c.reproduce ?? c.evidence });
    }
    if (repeated.length) {
      return block(state, "ruling", { reason: "qa_repeated_failure", stage: "dev", identities: repeated, cycles: [call.round - 1, call.round], rule: "the same failure in two QA cycles in a row", recovery: join(runDir, TODO_FIX) });
    }
    return checkThresholds(state, "dev");
  }

  // review
  state.lastReview[stage] = outPath;
  const mergedReview = stage === "dev" && state.devInput === "merge";
  if (stage === "dev") state.devInput = "review";
  // The stage's outcome is the engine's: blocking findings still open after DENKEN's dismissals.
  // When the reviewer's own verdict says otherwise, the record says both.
  const dismissedSet = new Set(state.dismissed[stage] ?? []);
  const raised = output.findings.filter((f) => f.severity === "blocking");
  const open = raised.filter((f) => !dismissedSet.has(identityOf(f, state.findings[stage])));
  const word = open.length ? "REJECTED" : "APPROVED";
  const said = output.verdict === "APPROVED" ? "APPROVED" : "REJECTED";
  const note = said === word ? null : `reviewer's verdict: ${said}; ${open.length} open blocking finding(s)${raised.length > open.length ? `, ${raised.length - open.length} already dismissed by DENKEN` : ""}`;
  const file = logStep(state, stage, `${call.role}-${word.toLowerCase()}-round${call.round}`, renderFindings(`${who} · ${stage} review, round ${call.round} · ${call.provider}`, output, { word, note }) + renderFacts(meta.facts));
  timeline(state, who, `${open.length ? `REJECTED (${open.length} blocking): ${oneLine(open[0].problem, 120)}` : "APPROVED"}${note ? ` (${note})` : ""}${factsBrief(meta.facts)} → ${file}`);
  verdict(state, `${STAGE_NAME[stage]} review${mergedReview ? " of the merged units" : ""}, round ${call.round}`, `${who} (${call.provider})`, word, output.summary ?? (open.length ? open[0].problem : "no findings"), { call: call.id, file, note });
  if (recordReview(state, stage, call, output.findings) === 0) approve(state, stage, outPath);
}
