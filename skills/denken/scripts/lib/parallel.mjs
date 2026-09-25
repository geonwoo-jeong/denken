// The parent of units: stepping them in parallel, confirming them together, merging them, and ruling on the split.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { EMPTY_TREE, EXCLUDE, fail, now, oneLine, pidAlive, print, REQUEST, ROOT, SCRIPT, sleep, TODO_DEV, TODO_QA, UNITS } from "./core.mjs";
import { signalGroup, stopCallGroup } from "./exec.mjs";
import { gitAt, gitText } from "./git.mjs";
import { projectPrint } from "./guard.mjs";
import { acquireLock, assertLock } from "./lock.mjs";
import { logDir, logRequest, logStep, timeline, verdict, writeVerdicts } from "./record.mjs";
import { parseRequest, requestProblems, section } from "./request.mjs";
import { block, callBase, load, readRunFile, save } from "./state.mjs";
import { confirmedHashes, planText } from "./todo.mjs";
import { addWorktree, createUnits, removeWorktree, tearDownUnits, unitsProblems } from "./units.mjs";

// ---------- the parent of units
// The parent steps each unit's run in the unit's worktree (next --wait 0), keeping at most
// limits.parallelUnits of them working at once, and brings DENKEN whatever a unit needs. A unit
// is queued (not started), working (a call runs), waiting (blocked on DENKEN or the user), ready
// (unblocked, waiting for a free slot), done, or aborted.
export function stepUnit(u) {
  const r = spawnSync(process.execPath, [SCRIPT, "next", u.run, "--wait", "0"], { cwd: u.root, encoding: "utf8", maxBuffer: 1 << 26 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { action: "error", error: `${u.id}'s engine printed no result (exit ${r.status}): ${oneLine(r.stderr, 400)}` };
  }
}

export const readUnit = (u) => {
  try {
    return JSON.parse(readFileSync(join(u.run, "state.json"), "utf8"));
  } catch {
    return null;
  }
};

// A unit's verdict lines, pulled into the parent's verdicts.md with the unit's name after the time.
export function pullVerdicts(state) {
  for (const u of state.units) {
    const lines = readUnit(u)?.verdicts ?? [];
    for (const line of lines.slice(u.pulled ?? 0)) writeVerdicts(state, line.replace(/^- (\d{2}:\d{2}:\d{2}) · /, `- $1 · ${u.id} · `));
    u.pulled = Math.max(u.pulled ?? 0, lines.length);
  }
}

export function unitAction(runDir, u) {
  const run = relative(ROOT, runDir);
  return { ...u.last, unit: u.id, unitTitle: u.title, run, next: `${u.last.next ?? ""} This is ${u.id}'s: run the command on this run with --unit ${u.id} (for example: rule ${run} --unit ${u.id} --decision ...). The other units keep working; run next again to move them on.`.trim() };
}

export const unitsSummary = (state) => state.units.map((u) => ({ unit: u.id, status: u.status, ...(u.last?.reason ? { reason: u.last.reason } : {}), ...(u.last?.call ? { call: u.last.call } : {}) }));

export async function stepUnits(runDir, state, deadline) {
  const limit = state.assignment.limits.parallelUnits ?? 3;
  for (;;) {
    let busy = state.units.filter((u) => u.status === "working").length;
    for (const u of state.units) {
      if (u.status === "done" || u.status === "aborted") continue;
      // A unit DENKEN has since unblocked is ready again, and needs a free slot like any other.
      if (u.status === "waiting" && (u.last?.action === "error" || readUnit(u)?.blocked?.since !== u.last?.since)) u.status = "ready";
      if (u.status === "waiting" || (u.status !== "working" && busy >= limit)) continue;
      const was = u.status;
      u.started = true;
      u.last = stepUnit(u);
      u.status = u.last.action === "done" ? "done" : u.last.action === "aborted" ? "aborted" : u.last.action === "running" ? "working" : "waiting";
      busy += (u.status === "working") - (was === "working");
    }
    pullVerdicts(state);
    // The units are merged into the project as it was when they started, so it must not change.
    if (projectPrint(runDir) !== state.mainPrint) {
      block(state, "user", { reason: "main_tree_changed", resolveWith: "retry", stage: "units", status: gitText("status", "--short", "--", ".", ...EXCLUDE).split("\n").filter(Boolean).slice(0, 20) });
      return null;
    }
    const aborted = state.units.find((u) => u.status === "aborted");
    if (aborted) {
      block(state, "user", { reason: "unit_aborted", resolveWith: "rule", stage: "units", unit: aborted.id });
      return null;
    }
    // Before the first confirmation, every unit's TODO lists are confirmed together.
    const gate = (u) => !state.unitsConfirmed && u.last?.reason === "confirm_todos";
    const needs = state.units.find((u) => u.status === "waiting" && !gate(u));
    if (needs) {
      if (state.blocked?.reason === "confirm_todos") state.blocked = null;
      return unitAction(runDir, needs);
    }
    if (!state.unitsConfirmed && state.units.every((u) => u.status === "waiting" && gate(u))) {
      if (state.blocked?.reason !== "confirm_todos") block(state, "user", { reason: "confirm_todos", resolveWith: "confirm", stage: "units" });
      return null;
    }
    if (state.units.every((u) => u.status === "done")) return mergeUnits(runDir, state);
    if (Date.now() >= deadline) return { action: "running", units: unitsSummary(state), next: "Run next again with --wait." };
    assertLock();
    save(runDir, state);
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
}

// Every unit is done: merge them all, or none. The units' patches (each against the common base,
// so commits an agent made are included) are applied together in an integration worktree first;
// only the combined patch that results is applied to the project.
export function mergeUnits(runDir, state) {
  const integration = join(state.unitHome, "INTEGRATION");
  removeWorktree(integration);
  addWorktree(integration, state.unitBase);
  const dir = join(runDir, "units");
  mkdirSync(dir, { recursive: true });
  const conflict = (unit, patch, error) => {
    block(state, "user", { reason: "merge_conflict", resolveWith: "retry", stage: "units", unit, patch, error: oneLine(error, 800) });
    return null;
  };
  const merged = [];
  for (const u of state.units) {
    gitAt(u.root, ["add", "-A", "--", ".", ...EXCLUDE]);
    const patch = gitAt(u.root, ["diff", "--cached", "--binary", state.unitBase, "--", ".", ...EXCLUDE]).out;
    const files = gitAt(u.root, ["diff", "--cached", "--name-only", state.unitBase, "--", ".", ...EXCLUDE]).out.toString("utf8").split("\n").filter(Boolean);
    const committed = gitAt(u.root, ["rev-parse", "HEAD"]).out.toString("utf8").trim() !== state.unitBase;
    const path = join(dir, `${u.id}.patch`);
    writeFileSync(path, patch);
    merged.push({ unit: u.id, files, committed });
    if (!patch.length) continue;
    const check = gitAt(integration, ["apply", "--check", "--binary", path]);
    if (!check.ok) return conflict(u.id, path, check.err);
    gitAt(integration, ["apply", "--binary", path]);
  }
  gitAt(integration, ["add", "-A", "--", "."]);
  const combined = gitAt(integration, ["diff", "--cached", "--binary", state.unitBase, "--", "."]).out;
  const all = join(dir, "merged.patch");
  writeFileSync(all, combined);
  if (projectPrint(runDir) !== state.mainPrint) {
    block(state, "user", { reason: "main_tree_changed", resolveWith: "retry", stage: "units", status: gitText("status", "--short", "--", ".", ...EXCLUDE).split("\n").filter(Boolean).slice(0, 20) });
    return null;
  }
  // The project before the merge is where the merged change is measured from.
  const base = gitText("stash", "create") || gitText("rev-parse", "-q", "--verify", "HEAD") || EMPTY_TREE;
  const untracked = gitText("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE).split("\n").filter(Boolean);
  if (combined.length) {
    const check = gitAt(ROOT, ["apply", "--check", "--binary", all]);
    if (!check.ok) return conflict("all", all, check.err);
    const applied = gitAt(ROOT, ["apply", "--binary", all]);
    if (!applied.ok) return conflict("all", all, applied.err);
  }
  state.stageBase.dev = base;
  (state.stageEnteredAt ??= {}).dev = now();
  (state.untrackedAtStage ??= {}).dev = untracked;
  composeMerged(runDir, state);
  state.confirmed = { at: now(), userSaid: state.unitsConfirmed?.userSaid ?? null, hashes: confirmedHashes(runDir), units: true };
  // The units' own records are already in the ai-log; keep each unit's final state beside them.
  const log = logDir(state);
  for (const u of state.units) {
    mkdirSync(join(log, "raw", u.id), { recursive: true });
    if (existsSync(join(u.run, "state.json"))) copyFileSync(join(u.run, "state.json"), join(log, "raw", u.id, "state.json"));
    copyFileSync(join(dir, `${u.id}.patch`), join(log, "raw", u.id, "merge.patch"));
  }
  const step = logStep(state, "dev", "engine-merge", `# Merge of the units\n\nEvery unit was planned, built, reviewed and verified in its own worktree. Their changes were applied together in an integration worktree, then to the project as one patch.\n\n${merged.map((m) => `## ${m.unit}${m.committed ? " (its agent committed; the commits are included)" : ""}\n\n${m.files.map((f) => `- ${f}`).join("\n") || "No changes."}`).join("\n\n")}\n`);
  verdict(state, "Merge", "ENGINE", "MERGED", `${merged.map((m) => `${m.unit} (${m.files.length} file(s))`).join(", ")} merged into the project; UBEL now reviews the merged change, then GENAU verifies it again`, { file: step });
  timeline(state, "ENGINE", `merged ${merged.map((m) => `${m.unit} (${m.files.length} file(s))`).join(", ")} → ${step}`);
  tearDownUnits(state);
  rmSync(state.unitHome, { recursive: true, force: true });
  try {
    if (!readdirSync(dirname(state.unitHome)).length) rmSync(dirname(state.unitHome), { recursive: true });
  } catch {}
  state.unitsMerged = now();
  state.stage = "dev";
  state.pending = "review";
  state.round.dev = 1;
  state.devInput = "merge";
  state.approved.plan = "units";
  return "merged";
}

// The merged TODO lists and report, from the units': every DEV item as ticked, with its
// evidence; every QA item unticked, to be verified again; and QA-001, the whole test suite.
export function composeMerged(runDir, state) {
  const r = parseRequest(readRunFile(runDir, REQUEST));
  const copies = (prefixes) => prefixes.flatMap((p) => r[p].items.map((i) => i.text)).join("\n") || "- None";
  const part = (u, file, heading) => (section(readRunFile(u.run, file), heading) ?? "").trim();
  const byUnit = (file, heading, shape = (x) => x) => state.units.map((u) => `### ${u.id}: ${u.title}\n\n${shape(part(u, file, heading)) || "- None"}`).join("\n\n");
  writeFileSync(join(runDir, TODO_DEV), `# Development TODO (merged)\n\nThe units' development TODO lists, merged. Each unit was built, reviewed and verified in its own worktree.\n\n## Acceptance\n${copies(["REQ"])}\n\n## Do not build\n${copies(["OUT", "LATER"])}\n\n## Cautions\n${copies(["CAUTION"])}\n\n## Approach\n${byUnit(TODO_DEV, "Approach")}\n\n## TODO\n${byUnit(TODO_DEV, "TODO")}\n\n## Open questions\n- None\n`);
  writeFileSync(join(runDir, TODO_QA), `# QA TODO (merged)\n\n## Checks\n- [ ] QA-001 (${r.REQ.items.map((i) => i.key).join(", ")}) The project's whole test suite passes on the merged result. How: run the project's full test command. Expected: every test passes.\n\n${byUnit(TODO_QA, "Checks", planText)}\n`);
  writeFileSync(join(runDir, "dev-report.md"), `# Development report (merged)\n\n${state.units.map((u) => `## ${u.id}: ${u.title}\n\n${readRunFile(u.run, "dev-report.md").replace(/^#[^\n]*\n/, "").trim() || "(none)"}`).join("\n\n")}\n`);
}

export function confirmUnits(runDir, state, userSaid) {
  if (state.blocked?.reason !== "confirm_todos") fail("nothing to confirm: the units are not all waiting for confirmation; run next");
  const questions = state.units.flatMap((u) => (u.last?.openQuestions ?? []).map((q) => `${u.id}: ${q}`));
  if (questions.length) fail(`cannot confirm while units have open questions: ${questions.join("; ")}. Ask the user, then replan those units with rule --unit <id> --decision replan.`);
  const failed = [];
  for (const u of state.units) {
    const r = spawnSync(process.execPath, [SCRIPT, "confirm", u.run, "--user-said", userSaid], { cwd: u.root, encoding: "utf8" });
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {}
    if (out?.action !== "confirmed") failed.push(`${u.id}: ${out?.error ?? oneLine(r.stderr, 300)}`);
  }
  // Units that were confirmed go ahead; any that were not are then confirmed one by one.
  if (failed.length < state.units.length) {
    state.unitsConfirmed = { at: now(), userSaid };
    state.blocked = null;
    timeline(state, "USER via DENKEN", `confirmed the units' TODO lists: "${oneLine(userSaid, 140)}"`);
    timeline(state, "RESUME", "the units start development");
  }
  assertLock();
  save(runDir, state);
  if (failed.length) fail(`not confirmed: ${failed.join("; ")}`);
  print({ action: "confirmed", units: state.units.map((u) => u.id), next: "Development starts in every unit. Run next with --wait." });
}

// Stops a unit's run: its call, if one is running, and the run itself (the _abort command).
export async function stopUnitRun(runDir) {
  if (!(await acquireLock(runDir, 15000))) fail("the unit's engine is busy");
  const state = load(runDir);
  if (state.inflight) {
    const base = callBase(runDir, state.inflight.id);
    await stopCallGroup(base, state.inflight.provider);
    const pid = Number(existsSync(`${base}.pid`) ? readFileSync(`${base}.pid`, "utf8") : 0);
    if (pid && pidAlive(pid)) signalGroup(pid, "SIGTERM");
    state.inflight = null;
  }
  state.stage = "aborted";
  state.blocked = null;
  timeline(state, "ENGINE", "stopped: the run it belongs to was aborted or split again");
  save(runDir, state);
  print({ action: "aborted" });
}

// A unit's run is stopped when the run it belongs to is aborted or split again.
export function abortUnits(state) {
  for (const u of state.units ?? []) {
    if (u.status !== "done" && existsSync(u.run)) spawnSync(process.execPath, [SCRIPT, "_abort", u.run], { cwd: u.root, encoding: "utf8" });
    u.status = u.status === "done" ? "done" : "aborted";
  }
}

export function ruleUnits(runDir, state, decision, note) {
  const id = `R${state.rulings.length + 1}`;
  const reason = state.blocked?.reason ?? "units";
  if (decision === "replan") {
    if (state.blocked?.reason !== "confirm_todos" || state.unitsConfirmed) fail("the split can change only while every unit waits for the first confirmation; to replan one unit, use --unit <id>");
    const problems = [...requestProblems(readRunFile(runDir, REQUEST)), ...unitsProblems(runDir).problems];
    if (problems.length) fail(`fix request.md and ${UNITS} before splitting again: ${problems.join("; ")}`);
    abortUnits(state);
    createUnits(runDir, state, unitsProblems(runDir).units);
    logRequest(state, runDir);
    state.blocked = null;
  } else if (decision === "abort") {
    abortUnits(state);
    state.stage = "aborted";
    state.blocked = null;
  } else fail("for the whole split, the decisions are replan (a new split) or abort; to rule on one unit, add --unit <id>");
  state.rulings.push({ id, stage: "units", subject: "the split", reason, decision, at: now() });
  const ruling = logStep(state, "plan", `denken-ruling-${id}-${decision}`, `# DENKEN · ruling ${id} · ${decision}\n\nOn: the split into units\n\n${note.trim()}\n`);
  timeline(state, "DENKEN", `ruling ${id} (${decision}) on the split: ${oneLine(note, 140)} → ${ruling}`);
  verdict(state, `Ruling ${id} on the split`, "DENKEN", decision.toUpperCase(), note, { file: ruling });
  appendFileSync(join(runDir, "rulings.md"), `${state.rulings.length === 1 ? "# Rulings\n\n" : ""}## ${id} · units · the split · ${decision}\n\n${note.trim()}\n\n`);
  assertLock();
  save(runDir, state);
  print({ action: "ruled", id, decision, stage: state.stage, ...(decision === "abort" ? { worktrees: state.units.map((u) => u.root) } : { units: state.units.map((u) => u.id) }), next: decision === "abort" ? "Tell the user the run was aborted. The units' worktrees are kept for inspection." : "Run next with --wait." });
}

// ---------- commands
