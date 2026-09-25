// A worker's result: its ticks applied, its step recorded, then the engine's own checks, which send
// the work straight back without spending a review on it.
import { writeFileSync } from "node:fs";
import { oneLine } from "./core.mjs";
import { recordReview } from "./findings.mjs";
import { logStep, STAGE_NAME, timeline, verdict } from "./record.mjs";
import { factsBrief, renderFindings, renderWork } from "./render.mjs";
import { block, callBase, readRunFile } from "./state.mjs";
import { applyTicks, devGaps } from "./ticks.mjs";
import { blockedIn, fixItems, todoGaps } from "./todo.mjs";
import { unitPlanGaps, unitScopeGaps } from "./units.mjs";
import { wikiGaps } from "./wiki.mjs";

const CHECKED = { plan: "engine check of the TODO lists against request.md", dev: "engine check of the TODO items' ticks and recorded test runs", wiki: "engine check that only documentation changed" };

export function ingestWork(runDir, state, call, meta) {
  const stage = call.stage;
  state.lastWork[stage] = { call: call.id, denials: meta.denials, provider: call.provider, modelRan: meta.facts?.modelRan ?? null, effort: meta.facts?.effort ?? null };
  state.pending = "review";
  const rejectedTicks = stage === "dev" ? takeTicks(runDir, state, call) : [];
  const who = call.role.toUpperCase();
  const step = logStep(state, stage, `${call.role}-round${call.round}`, renderWork(runDir, state, call, call.provider, meta.facts));
  verdict(state, `${STAGE_NAME[stage]}${stage === "dev" && state.devInput === "qa" ? " (QA fix)" : ""}, round ${call.round}`, `${who} (${call.provider})`, "READY", readRunFile(runDir, `calls/${call.id}.out.md`), { call: call.id, file: step });
  timeline(state, who, `finished ${stage} round ${call.round}${factsBrief(meta.facts)}: ${oneLine(readRunFile(runDir, `calls/${call.id}.out.md`), 160)} → ${step}`);
  if (returnedByEngine(runDir, state, call, rejectedTicks)) return;
  if (fixBlocked(runDir, state, call)) return;
  // Permissions that blocked the worker twice in a row need DENKEN.
  state.denialStreak[stage] = meta.denials.length ? (state.denialStreak[stage] ?? 0) + 1 : 0;
  if (state.denialStreak[stage] >= 2) {
    block(state, "permission", { reason: "repeated_permission_denials", resolveWith: "grant", call: call.id, callInfo: call, role: call.role, provider: call.provider, requests: [], denials: meta.denials });
  }
}

// STARK's recorded ticks, written into the TODO files; the records the engine refuses come back.
function takeTicks(runDir, state, call) {
  const { applied, rejected } = applyTicks(runDir, state, call);
  if (applied.length) timeline(state, call.role.toUpperCase(), `ticked ${applied.map((e) => e.item).join(", ")}, each with its test run and evidence`);
  if (rejected.length) timeline(state, "ENGINE", `tick record(s) not accepted: ${rejected.map((r) => `${r.item} (${r.problem})`).join("; ")}`);
  return rejected;
}

// Deterministic checks run before the reviewer: TODO lists with coverage gaps go straight back to
// METHODE, and DEV items STARK neither ticked off nor reported blocked go straight back to STARK,
// as an engine round, without spending a review on them.
function returnedByEngine(runDir, state, call, rejectedTicks) {
  const stage = call.stage;
  const gaps = stage === "plan" ? [...todoGaps(runDir), ...unitPlanGaps(runDir, state)] : stage === "dev" ? [...devGaps(runDir, state, rejectedTicks), ...unitScopeGaps(state)] : wikiGaps(state);
  if (!gaps.length) return false;
  const gapsPath = `${callBase(runDir, call.id)}.gaps.json`;
  const checked = CHECKED[stage];
  writeFileSync(gapsPath, JSON.stringify({ verdict: "CHANGES_REQUESTED", findings: gaps, checked: [checked] }, null, 2));
  state.lastReview[stage] = gapsPath;
  if (stage === "dev") state.devInput = "review";
  const file = logStep(state, stage, `engine-check-round${call.round}`, renderFindings(`ENGINE · ${checked}`, { findings: gaps, checked: [checked] }));
  timeline(state, "ENGINE", `${gaps.length} problem(s) found by the engine → back to ${call.role.toUpperCase()} without a review: ${oneLine(gaps[0].problem, 120)} → ${file}`);
  verdict(state, `${STAGE_NAME[stage]} check, round ${call.round}`, "ENGINE", "RETURNED", gaps.map((g) => g.problem).join("; "), { call: call.id, file });
  recordReview(state, stage, call, gaps);
  return true;
}

// A recovery item STARK reports blocked needs a decision above STARK's head.
function fixBlocked(runDir, state, call) {
  if (call.stage !== "dev" || state.devInput !== "qa") return false;
  const report = readRunFile(runDir, "dev-report.md");
  const stuck = fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle && !f.done && blockedIn(report, f.key));
  if (!stuck.length) return false;
  timeline(state, call.role.toUpperCase(), `reported recovery item(s) blocked: ${stuck.map((f) => f.key).join(", ")}`);
  block(state, "ruling", { reason: "fix_blocked", stage: "dev", items: stuck.map((f) => ({ item: f.key, text: f.text, report: report.split("\n").find((l) => blockedIn(l, f.key))?.trim() ?? "" })), rule: "a recovery item reported blocked" });
  return true;
}
