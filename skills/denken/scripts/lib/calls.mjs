// Building a call (its prompt and job) and launching it as a separate process.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageChanges } from "./changes.mjs";
import { ARTIFACTS, EMPTY_TREE, EXCLUDE, now, REQUEST, REVIEWER, ROOT, SCRIPT, SKILL_DIR, TODO_DEV, TODO_FIX, TODO_QA, WORKER } from "./core.mjs";
import { git } from "./git.mjs";
import { agentFor, agentLabel } from "./levels.mjs";
import { timeline } from "./record.mjs";
import { scopeReport } from "./scope.mjs";
import { seedFor, seedPrompt } from "./seeds.mjs";
import { continueFor, sinceLastCall } from "./sessions.mjs";
import { callBase, save } from "./state.mjs";
import { fixItems } from "./todo.mjs";
import { isDoc, relatedDocs } from "./wiki.mjs";

export function knownTopics(state, stage) {
  const seen = new Map();
  for (const f of state.findings[stage] ?? []) seen.set(f.identity, { identity: f.identity, topic: f.topic, file: f.file, request_item: f.request_item, raised: state.counts[stage]?.[f.identity] ?? 0 });
  return [...seen.values()];
}

export function buildCall(runDir, state, call) {
  const p = (f) => join(runDir, f);
  const read = [];
  const write = [];
  const frozen = call.mode !== "work" || call.stage === "plan";
  const guard = { frozen, ignored: call.mode === "qa" ? "env" : frozen ? "all" : "none", allow: [] };
  const extra = [];
  const lastReview = state.lastReview[call.stage];

  // Who reads what is deliberate: STARK builds from the development TODO alone, GENAU tests
  // from the request and the QA TODO, and every reviewer judges against the request.
  if (call.mode === "work") {
    if (call.stage === "plan") read.push(p(REQUEST));
    if (call.stage === "dev") read.push(p(TODO_DEV));
    if (call.stage === "wiki") read.push(p(REQUEST), p(TODO_DEV), p("dev-report.md"), state.lastQa);
    if (call.stage === "dev" && state.devInput === "qa") read.push(p(TODO_FIX));
    else if (call.round > 1 && lastReview) read.push(lastReview);
    write.push(...ARTIFACTS[call.stage].map(p));
    guard.allow.push(...ARTIFACTS[call.stage]);
    if (call.stage === "plan") extra.push(`Do not change any project file. Write only ${TODO_DEV} and ${TODO_QA}.`);
    if (call.stage === "wiki") {
      const docs = relatedDocs(state.runChanges ?? [], state.runDeleted ?? []);
      const must = docs.filter((d) => d.mustUpdate);
      extra.push(`Files changed in this run: ${(state.runChanges ?? []).join(", ") || "none"}${state.runDeleted?.length ? ` (deleted: ${state.runDeleted.join(", ")})` : ""}.\n  Existing docs that mention them: ${docs.map((d) => `${d.doc} (${d.mentions.join(", ")})`).join("; ") || "none"}.${must.length ? `\n  Must update, because they mention files this run deleted: ${must.map((d) => d.doc).join(", ")}.` : ""}\n  Update only the documentation these changes affect: those docs, or a new page under docs/ when no existing page covers them. Leave unrelated pages alone, change no file that is not documentation, and do not touch agent configuration (CLAUDE.md, AGENTS.md, .claude/, .codex/, .agents/).`);
    }
    if (call.stage === "dev") {
      extra.push(`When an item is built, tick it off through the engine: node "${SCRIPT}" tick "${runDir}" <DEV-001|FIX-001> --evidence "<what was done, and where: name the files>" -- <command> <args...> (for example: -- node --test test/a.test.js). The command runs as given, without a shell. The tick is recorded only if the command passes and the evidence names a file changed for that item (since its last tick, or since development began). For an item that truly needs no change, pass --no-change "<why>" instead of --evidence. The engine writes the ticks and evidence into ${TODO_DEV} and ${TODO_FIX} when your call ends; do not edit those files.`);
      if (state.devInput === "qa") {
        const fixes = fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle).map((f) => f.key);
        extra.push(`This round fixes what independent QA found: the recovery items ${fixes.join(", ")} under "QA cycle ${state.currentFixCycle}" in ${TODO_FIX}. Fix each cause in general, re-tick the DEV items the engine unticked, and tick each FIX item off with a test that reproduces its failure.`);
      }
    }
  } else if (call.mode === "review") {
    read.push(p(REQUEST));
    if (call.stage === "dev") read.push(p(TODO_DEV));
    read.push(...ARTIFACTS[call.stage].map(p));
    if (call.stage !== "plan") {
      const diffPath = `${callBase(runDir, call.id)}.diff`;
      const base = state.stageBase[call.stage] || EMPTY_TREE;
      writeFileSync(diffPath, Buffer.concat([git("diff", base, "--", ".", ...EXCLUDE), Buffer.from("\n# Untracked files (read them directly)\n"), git("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE)]));
      read.push(diffPath);
    }
    if (lastReview) read.push(lastReview);
    if (call.stage === "dev") extra.push(`Scope facts computed by the engine:\n  ${scopeReport(runDir, state)}`);
    if (call.stage === "dev" && state.devInput === "merge") {
      extra.push(`This is the merged result of units built in parallel, each already reviewed on its own: ${state.units.map((u) => `${u.id} "${u.title}" (${u.reqs.join(", ")}, in ${u.scope.join(", ")})`).join("; ")}. Review what no unit's reviewer could see: how the units fit together. Look for duplicated helpers, inconsistent names or APIs, conflicting assumptions, and a change in one unit that breaks another.`);
    }
    if (call.stage === "wiki") {
      extra.push(`Code changed in this run: ${(state.runChanges ?? []).filter((f) => !isDoc(f)).join(", ") || "none"}.\n  Docs changed in this stage: ${stageChanges(state, "wiki").changed.join(", ") || "none"}.\n  Read the code each changed doc describes, and check that the description matches it. Flag docs changed for no reason related to these changes.`);
    }
    if (call.stage === "dev" && state.devInput === "qa") {
      read.push(p(TODO_FIX));
      extra.push(`This round fixes what independent QA found (QA cycle ${state.currentFixCycle} in ${TODO_FIX}). Check that each fix is general: no special-casing of the reported inputs, no hard-coded expected outputs, no weakened or deleted tests.`);
    }
    const topics = knownTopics(state, call.stage);
    if (topics.length) extra.push(`Known topics in this stage. For the same issue, reuse the same topic, file and request_item:\n${topics.map((t) => `  - ${t.identity} (topic "${t.topic}", file ${t.file ?? "none"}, request_item ${t.request_item ?? "none"}, raised ${t.raised}x)`).join("\n")}`);
    const dismissed = state.dismissed[call.stage] ?? [];
    if (dismissed.length) extra.push(`Dismissed by DENKEN. Do not raise these again: ${dismissed.join(", ")}`);
    const denials = state.lastWork[call.stage]?.denials ?? [];
    if (denials.length) extra.push(`The worker had ${denials.length} action(s) blocked by permissions in its last call. Check that nothing the work depends on was skipped:\n${denials.map((d) => `  - ${d.tool}: ${JSON.stringify(d.input).slice(0, 200)}`).join("\n")}`);
  } else {
    read.push(p(REQUEST), p(TODO_QA));
    if (state.units) extra.push(`This is the check after the merge: ${state.units.map((u) => u.id).join(", ")} were built in parallel, each verified on its own, then merged. Run every item against the merged product, starting with QA-001, the whole test suite.`);
    extra.push(`Save the evidence for each item as files in ${callBase(runDir, call.id)}.evidence/ (command output, logs, and screenshots when there is a UI), and list each item's files in evidence_files.`);
  }
  if (existsSync(p("rulings.md"))) read.push(p("rulings.md"));
  if (call.mode !== "review") {
    extra.push(`If a missing permission stops you (network access, a path outside the project, a blocked command), do not work around it. Ask for it with: node "${SCRIPT}" request-permission "${runDir}" --need "<network | dir:<path> | tool:<pattern> | anything else>" --why "<what it is for>". Then stop and end your turn with a one-line summary; DENKEN decides and runs you again.`);
  }

  const agent = agentFor(state, call);
  // A reviewer's prompt is its stage checklist followed by the rules every reviewer shares.
  const roleFile = (name) => readFileSync(join(SKILL_DIR, "roles", `${name}.md`), "utf8").trimEnd();
  const roleText = call.mode === "review" ? `${roleFile(call.role)}\n\n${roleFile("reviewer")}` : roleFile(call.role);
  const lines = [
    "## This call",
    "",
    `- Role: ${call.role.toUpperCase()}`,
    `- Stage: ${call.stage}, round ${call.round}. You run on ${agent.provider}${agent.model ? ` (${agent.model})` : ""}.`,
    `- Project root: ${ROOT}`,
    ...(state.unit ? [`- Unit: ${state.unit} (${state.title}). Scope: ${state.scope.join(", ")}. This is the unit's own worktree; other units are built in parallel in theirs.`] : []),
    `- Run directory: ${runDir}`,
    `- Read:\n${read.map((f) => `  - ${f}`).join("\n")}`,
  ];
  if (write.length) lines.push(`- Write:\n${write.map((f) => `  - ${f}`).join("\n")}`);
  for (const e of extra) lines.push(`- ${e}`);
  if (call.mode !== "work") lines.push("- Your final message must be JSON that matches the provided schema.");
  // The role's instructions never change between calls, so they go where they can be cached (the
  // system prompt, for Claude); this call's facts follow as the message.
  return { system: `${roleText.trimEnd()}\n`, prompt: `${lines.join("\n")}\n`, guard, agent };
}

export function nextCall(state) {
  if (state.retryCall) {
    const c = state.retryCall;
    state.retryCall = null;
    return c;
  }
  const stage = state.stage;
  if (stage === "qa") return { stage, role: "genau", mode: "qa", round: ++state.round.qa, attempt: 1 };
  if (state.pending === "work") return { stage, role: WORKER[stage], mode: "work", round: ++state.round[stage], attempt: 1 };
  return { stage, role: REVIEWER[stage], mode: "review", round: state.round[stage], attempt: 1 };
}

export function launch(runDir, state) {
  const call = nextCall(state);
  call.id = `${call.stage}-${call.role}-${call.round}`;
  call.nonce = randomUUID();
  const base = callBase(runDir, call.id);
  const { system, prompt, guard, agent } = buildCall(runDir, state, call);
  // Keep an earlier attempt's files for debugging, out of the way of the new attempt.
  const stamp = Date.now();
  for (const suffix of [".meta.json", ".pid", ".cli.pid", ".heartbeat", ".out.json", ".out.md", ".log"]) {
    if (existsSync(base + suffix)) renameSync(base + suffix, `${base}.prev-${stamp}${suffix}`);
  }
  const seed = seedFor(runDir, state, call, agent);
  const cont = continueFor(state, call, agent);
  writeFileSync(`${base}.system.md`, system);
  // A forked session keeps its seed's system prompt, so a seeded call's role goes in its message.
  const fresh = seed ? `${system}\n---\n\n${prompt}- You start from the context FLAMME loaded (above), shared by every call of your kind (worker, reviewer or QA). Files may have changed since: read a file again before relying on it.${call.mode === "work" ? "" : " FLAMME's JSON at the end of it (CONTEXT_LOADED) only marked the context as loaded; it is not a result, and says nothing about the work."}\n` : prompt;
  // A continued session already holds the role's instructions and its own earlier work.
  const since = cont ? sinceLastCall(runDir, state, call, cont.since) : [];
  writeFileSync(`${base}.prompt.md`, cont ? `${prompt}- You continue your own session from ${cont.from}: your earlier work in this stage is above. Since then:\n${since.map((l) => `  - ${l}`).join("\n") || "  - nothing but what is listed under Read"}\n  Files may have changed: read a file again before relying on it.\n` : fresh);
  if (cont) writeFileSync(`${base}.prompt.fresh.md`, fresh);
  if (seed && !seed.sessionId) writeFileSync(`${base}.seed.prompt.md`, seedPrompt(runDir, state, call));
  const timeoutMs = Math.round(state.assignment.limits.callTimeoutMin * 60000);
  const grants = call.mode === "review" ? null : state.grants?.[call.role] ?? null;
  if (call.mode === "qa") mkdirSync(`${base}.evidence`, { recursive: true });
  // A unit's record lives in the parent's ai-log, outside the unit's worktree, where siblings
  // write too: the unit's guard covers its worktree, and Claude is denied the main checkout.
  writeFileSync(`${base}.job.json`, JSON.stringify({ ...call, agent: { ...agent, grants }, guard, timeoutMs, log: state.unit ? null : state.log ?? null, protect: state.mainRoot ?? null, seed, continue: cont, stageBase: state.stageBase[call.stage] ?? null }, null, 2));
  state.inflight = { ...call, provider: agent.provider, started: now() };
  timeline(state, `${call.role.toUpperCase()} (${agentLabel(agent)})`, `started ${call.stage === "qa" ? `QA cycle ${call.round}` : `${call.stage} round ${call.round}`}${call.attempt > 1 ? `, attempt ${call.attempt}` : ""}${cont ? `, continuing its session from ${cont.from}` : ""}`);
  state.calls.push({ id: call.id, mode: call.mode, provider: agent.provider, model: agent.model, attempt: call.attempt, started: state.inflight.started });
  save(runDir, state);
  const child = spawn(process.execPath, [SCRIPT, "_exec", runDir, call.id], { cwd: ROOT, detached: true, stdio: "ignore" });
  writeFileSync(`${base}.pid`, String(child.pid));
  child.unref();
}
