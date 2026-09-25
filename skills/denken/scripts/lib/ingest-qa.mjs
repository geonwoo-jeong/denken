// GENAU's QA report. Every QA item must be reported, and one that is missing counts as failed. A
// pass approves QA; a failure goes back to development with a recovery TODO written from the
// evidence, and the DEV items serving the failing request items are unticked.
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { changeTree } from "./changes.mjs";
import { now, oneLine, TODO_DEV, TODO_FIX, TODO_QA } from "./core.mjs";
import { checkThresholds } from "./findings.mjs";
import { logPart, logQa, logStep, STAGE_LOG, timeline, verdict } from "./record.mjs";
import { approve } from "./stages.mjs";
import { block, readRunFile } from "./state.mjs";
import { setTick } from "./ticks.mjs";
import { parseItems } from "./todo.mjs";

export function ingestQa(runDir, state, call, meta, output, outPath) {
  state.lastQa = outPath;
  const { items, failing, reqOf, identity } = qaResults(runDir, state, output);
  // The QA list records what was verified: each checked item is ticked with GENAU's evidence.
  for (const c of items) setTick(runDir, "QA", c.id, c.result === "PASS", c.result === "PASS" ? `${c.evidence} (verified by: ${c.how_verified ? `${c.how_verified}; ` : ""}${call.id})` : null);
  logQa(state, runDir, call, items, meta.facts);
  const folder = `${logPart(state, STAGE_LOG.qa)}/qa-${call.round}`;
  const summary = output.summary ?? (failing.length ? failing.map((c) => `${c.id} failed`).join(", ") : "all checks passed");
  const agreed = (output.result === "PASS") === !failing.length;
  verdict(state, `Independent QA${state.units ? " after the merge" : ""}, cycle ${call.round}`, `GENAU (${call.provider})`, failing.length ? "FAILED" : "PASSED", summary, { call: call.id, file: `${folder}/report.md`, note: agreed ? null : `GENAU's result: ${output.result}; ${failing.length} failing item(s) after dismissals and missing items` });
  timeline(state, call.role.toUpperCase(), failing.length ? `FAILED QA cycle ${call.round}: ${failing.map((c) => c.id).join(", ")} → ${folder}/` : `PASSED QA cycle ${call.round} (${items.length} checks) → ${folder}/`);
  if (failing.length === 0) return approve(state, "qa", outPath);
  const cycle = state.round.qa;
  writeRecovery(runDir, state, call, failing, reqOf);
  untickFailing(runDir, state, failing, reqOf, cycle);
  state.approved.dev = null;
  state.devInput = "qa";
  state.stage = "dev";
  state.pending = "work";
  // The engine can write a recovery TODO, but it cannot find a root cause. The same failure in two
  // QA cycles in a row goes to DENKEN instead of producing yet another FIX item.
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

// Every QA item's result (a missing one failed), the failing ones not dismissed, and the request
// items each one checks.
function qaResults(runDir, state, output) {
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
  return { items, failing, reqOf, identity };
}

// The recovery TODO: STARK sees what broke and how to reproduce it, not the QA TODO list. The dev
// stage's diff base is kept, so the next review sees every change since development began.
function writeRecovery(runDir, state, call, failing, reqOf) {
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
}

// The checkboxes must stay truthful: DEV items serving a failing request item are unticked, and need
// fresh evidence and a passing test run to be ticked again.
function untickFailing(runDir, state, failing, reqOf, cycle) {
  const failingReq = new Set(failing.flatMap(reqOf));
  for (const d of parseItems(readRunFile(runDir, TODO_DEV), "DEV").items) {
    if (d.done && d.refs.some((r) => failingReq.has(r)) && setTick(runDir, "DEV", d.key, false)) {
      (state.unticked ??= {})[d.key] = { at: now(), cycle, tree: changeTree(state) };
    }
  }
}
