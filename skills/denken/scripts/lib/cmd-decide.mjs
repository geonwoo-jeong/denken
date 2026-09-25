// Commands DENKEN decides with: rulings, retries, confirmation, permissions, secrets and levels.
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fail, now, oneLine, print, REQUEST, ROOT, TODO_DEV, TODO_QA } from "./core.mjs";
import { actionFor } from "./flow.mjs";
import { projectPrint } from "./guard.mjs";
import { agentLabel, choiceProblems, parseChoices, roleAgents } from "./levels.mjs";
import { assertLock } from "./lock.mjs";
import { confirmUnits, ruleUnits } from "./parallel.mjs";
import { logRequest, logStep, scanSecrets, STAGE_LOG, STAGE_NAME, timeline, verdict } from "./record.mjs";
import { contract, requestItems, requestProblems, reusedIds } from "./request.mjs";
import { approve, enterStage, finish } from "./stages.mjs";
import { load, readRunFile, save } from "./state.mjs";
import { confirmedHashes, openQuestions, todoGaps } from "./todo.mjs";
import { unitPlanGaps } from "./units.mjs";

export function cmdRule(runDir, args) {
  const state = load(runDir);
  if (!state.blocked && state.stage !== "units") fail("nothing to rule on: the run is not blocked");
  const decision = args[args.indexOf("--decision") + 1];
  if (!["uphold", "dismiss", "replan", "abort"].includes(decision)) fail("--decision must be uphold, dismiss, replan or abort");
  const noteIndex = args.indexOf("--note");
  const fileIndex = args.indexOf("--note-file");
  const note = noteIndex >= 0 ? args[noteIndex + 1] : fileIndex >= 0 ? readFileSync(args[fileIndex + 1], "utf8") : null;
  if (!note?.trim()) fail("a ruling needs --note <text> or --note-file <path> explaining the decision and the direction");

  if (state.stage === "units") return ruleUnits(runDir, state, decision, note);
  const b = state.blocked;
  const stage = b.stage ?? state.stage;
  if (["confirm_todos", "scope_changed"].includes(b.reason) && !["replan", "abort"].includes(decision)) {
    fail("at the TODO confirmation, use confirm when the user approves, or rule --decision replan|abort");
  }
  if (decision === "replan") {
    const problems = [...requestProblems(readRunFile(runDir, REQUEST)), ...reusedIds(runDir, state)];
    if (problems.length) fail(`fix request.md before replanning: ${problems.join("; ")}`);
  }
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
  const ruling = logStep(state, STAGE_LOG[stage] ? stage : "plan", `denken-ruling-${id}-${decision}`, `# DENKEN · ruling ${id} · ${decision}\n\nOn: ${subject} (${b.reason})\n\n${note.trim()}\n`);
  timeline(state, "DENKEN", `ruling ${id} (${decision}) on ${subject}: ${oneLine(note, 140)} → ${ruling}`);
  verdict(state, `Ruling ${id} on ${subject}`, "DENKEN", decision.toUpperCase(), note, { file: ruling });
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
    // A new plan starts from new seeds.
    state.seedEpoch = (state.seedEpoch ?? 0) + 1;
    state.devInput = null;
    state.confirmed = null;
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
      verdict(state, `${STAGE_NAME[stage] ?? stage} review`, "DENKEN", "APPROVED", `no blocking finding is left open: ${targets.join(", ")} dismissed`, { file: ruling, note: `by ruling ${id}` });
      approve(state, stage, `${state.lastReview[stage]} + ruling ${id}`);
    }
  }
  assertLock();
  save(runDir, state);
  timeline(state, "RESUME", state.stage === "aborted" ? "the run was aborted" : `the run continues in ${state.stage}`);
  print({ action: "ruled", id, decision, stage: state.stage, next: state.stage === "aborted" ? "Tell the user the run was aborted." : "Run next with --wait." });
}

export function cmdRetry(runDir) {
  const state = load(runDir);
  const b = state.blocked;
  if (!b || b.kind !== "user") fail("nothing to retry: the run is not waiting on the user");
  if (b.resolveWith !== "retry") fail(`this block is resolved with ${b.resolveWith}, not retry`);
  if (b.reason === "same_model_ran" && agentLabel(roleAgents(state)[b.role]) === b.ranAs) {
    fail(`${b.role} would run the same way again (${b.ranAs}); change it first with levels <run> ${b.role}=<level> --note '<why>' (or --model / --effort)`);
  }
  // Units: the project as it is now becomes what they are merged into, and the merge is tried again.
  if (state.stage === "units") {
    state.blocked = null;
    state.mainPrint = projectPrint(runDir);
    timeline(state, "DENKEN", `retry after ${b.reason}`);
    assertLock();
    save(runDir, state);
    return print({ action: "resumed", next: "Run next with --wait." });
  }
  state.blocked = null;
  const last = state.calls.findLast((c) => c.id === b.call);
  const [stage, role, round] = b.call.split("-");
  state.retryCall = { stage, role, mode: last.mode, round: Number(round), attempt: 1 };
  if (last.mode === "work") state.pending = "work";
  timeline(state, "DENKEN", `retry ${b.call} after ${b.reason}`);
  assertLock();
  save(runDir, state);
  print({ action: "resumed", next: "Run next with --wait." });
}

export function cmdConfirm(runDir, args) {
  const state = load(runDir);
  const i = args.indexOf("--user-said");
  const userSaid = i >= 0 ? String(args[i + 1] ?? "").trim() : "";
  if (!userSaid) fail("record the user's approval: confirm <run> --user-said '<what they said, verbatim>'");
  if (state.stage === "units") return confirmUnits(runDir, state, userSaid);
  if (!["confirm_todos", "scope_changed"].includes(state.blocked?.reason)) fail("nothing to confirm: the run is not waiting for TODO confirmation");
  if (state.blocked.reason === "scope_changed") {
    const current = confirmedHashes(runDir);
    const reviewed = ["request", "todoDev"].filter((k) => current[k] !== state.confirmed.hashes[k]);
    if (reviewed.length) fail(`${reviewed.join(" and ")} changed since the user confirmed; no reviewer has checked the new content. Restore it, or run rule --decision replan.`);
  }
  const problems = [...requestProblems(readRunFile(runDir, REQUEST)), ...reusedIds(runDir, state), ...[...todoGaps(runDir), ...unitPlanGaps(runDir, state)].map((g) => g.problem)];
  if (problems.length) fail(`cannot confirm: ${problems.join("; ")}. Fix request.md and replan.`);
  const questions = openQuestions(runDir);
  if (questions.length) fail(`cannot confirm while todo-dev.md has open questions: ${questions.join("; ")}. Ask the user, write the answers into request.md, then replan.`);
  state.blocked = null;
  state.confirmed = { at: now(), userSaid, hashes: confirmedHashes(runDir) };
  for (const i of requestItems(runDir)) (state.requestIds ??= {})[i.key] = contract(i.text);
  (state.confirmations ??= []).push(state.confirmed);
  logRequest(state, runDir);
  const file = logStep(state, "plan", "user-confirmed", `# The user confirmed the scope and TODO lists\n\n> ${userSaid}\n\nConfirmed content (hashes, with checkbox state ignored):\n\n${Object.entries(state.confirmed.hashes).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n\n## todo-dev.md\n\n${readRunFile(runDir, TODO_DEV).trim()}\n\n## todo-qa.md\n\n${readRunFile(runDir, TODO_QA).trim()}\n`);
  timeline(state, "USER via DENKEN", `confirmed the scope and TODO lists: "${oneLine(userSaid, 140)}" → ${file}`);
  verdict(state, "Confirmation", "USER", "CONFIRMED", userSaid, { file });
  timeline(state, "RESUME", "development starts");
  assertLock();
  save(runDir, state);
  print({ action: "confirmed", next: "Development starts. Run next with --wait." });
}

// DENKEN's answer to a permission request. A grant widens what the role may do for the rest of
// the run; either way the same call runs again, and the decision is written to rulings.md.
// Grants are kept narrow on purpose, because the request text comes from the worker:
//   --dir     inside the project; outside it only with the user's words, and never / or a home
//   --domain  network access to named hosts (Claude); --network for all hosts needs the user's words
//   --tool    Bash(<command> ...) patterns that start with a literal command (Claude only)
export function cmdPermissionDecision(runDir, args, decision) {
  const state = load(runDir);
  const b = state.blocked;
  if (b?.kind !== "permission") fail("nothing to decide: the run is not waiting on a permission request");
  const value = (flag) => (args.indexOf(flag) >= 0 ? String(args[args.indexOf(flag) + 1] ?? "").trim() : "");
  const all = (flag) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
  const note = value("--note");
  const userSaid = value("--user-said");
  if (!note) fail(`${decision} needs --note <why>, so the worker and the record know the reason`);
  if (b.userRequired && !userSaid) fail(`this role has asked too often (${b.reason}); ask the user and pass their answer with --user-said '<verbatim>'`);
  const grant = { network: args.includes("--network"), domains: all("--domain"), dirs: all("--dir").map((d) => resolve(ROOT, d)), tools: all("--tool") };
  if (decision === "grant") {
    if (!grant.network && !grant.domains.length && !grant.dirs.length && !grant.tools.length) fail("name what to grant: --domain <host>, --dir <path>, --tool <pattern>, or --network");
    // Real paths, so a symlink inside the project cannot point a grant at the home directory.
    const home = process.env.HOME ? realpathSync(process.env.HOME) : "";
    const root = realpathSync(ROOT);
    const sensitive = [".ssh", ".aws", ".gnupg", ".config", ".claude", ".codex", ".kube", ".docker", ".netrc"].map((d) => join(home, d));
    grant.dirs = grant.dirs.map((d) => {
      if (!existsSync(d)) fail(`${d} does not exist`);
      return realpathSync(d);
    });
    for (const d of grant.dirs) {
      if (d === "/" || d === home || home.startsWith(`${d}/`)) fail(`refusing to grant ${d}: it is a root or home directory`);
      if (sensitive.some((x) => d === x || d.startsWith(`${x}/`))) fail(`refusing to grant ${d}: it holds credentials or agent configuration`);
      if (d !== root && !d.startsWith(`${root}/`) && !userSaid) fail(`${d} is outside the project; ask the user and pass their answer with --user-said '<verbatim>'`);
    }
    if (grant.network && !userSaid) fail("--network opens every host; prefer --domain <host>, or ask the user and pass their answer with --user-said");
    if (grant.domains.length && b.provider !== "claude") fail("--domain grants apply to Claude only; Codex network access is all or nothing (--network, with --user-said)");
    if (grant.tools.length && b.provider !== "claude") fail("--tool grants apply to Claude only; Codex has no per-command allowlist");
    // An allow rule approves before auto mode's classifier looks, so a pattern for a shell, an
    // interpreter or a network tool would be arbitrary execution.
    const RUNS_ANYTHING = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "env", "exec", "eval", "xargs", "sudo", "su", "node", "deno", "bun", "npx", "bunx", "python", "python3", "ruby", "perl", "php", "lua", "osascript", "pwsh", "powershell", "curl", "wget", "nc", "ncat", "ssh", "scp", "rsync", "ftp", "telnet"]);
    for (const t of grant.tools) {
      const m = t.match(/^Bash\(([A-Za-z0-9_.\/-]+)(?: [^)]*)?\)$/);
      if (!m) fail(`refusing tool pattern ${t}: use Bash(<command> ...) starting with a literal command, never a bare wildcard`);
      if (RUNS_ANYTHING.has(basename(m[1]))) fail(`refusing tool pattern ${t}: ${m[1]} can run anything`);
      if (/\*\)$/.test(t) && !userSaid) fail(`${t} ends in a wildcard; ask the user and pass their answer with --user-said '<verbatim>'`);
    }
  }
  const current = ((state.grants ??= {})[b.role] ??= { network: false, domains: [], dirs: [], tools: [] });
  current.domains ??= [];
  if (decision === "grant") {
    current.network ||= grant.network;
    current.domains = [...new Set([...current.domains, ...grant.domains])];
    current.dirs = [...new Set([...current.dirs, ...grant.dirs])];
    current.tools = [...new Set([...current.tools, ...grant.tools])];
  }
  const what = decision === "grant" ? [grant.network && "network (all hosts)", ...grant.domains.map((d) => `domain ${d}`), ...grant.dirs.map((d) => `dir ${d}`), ...grant.tools.map((t) => `tool ${t}`)].filter(Boolean).join(", ") : b.requests.map((r) => r.need).join(", ") || "the blocked actions";
  const id = `P${(state.permissionDecisions ?? []).length + 1}`;
  (state.permissionDecisions ??= []).push({ id, call: b.call, role: b.role, decision, by: "denken", what, note, userSaid: userSaid || null, requests: b.requests, at: now() });
  const file = logStep(state, b.callInfo.stage, `denken-permission-${id}-${decision}`, `# DENKEN · permission ${id} · ${decision} · ${b.role.toUpperCase()}\n\nAsked for: ${b.requests.map((r) => `${r.need} (${r.why})`).join("; ") || "permission denials"}\n\n${decision === "grant" ? `Granted: ${what}` : "Denied"}\n\n${note}\n${userSaid ? `\nThe user said: "${userSaid}"\n` : ""}`);
  timeline(state, "DENKEN", `${decision === "grant" ? `granted ${what} to` : `denied ${what} for`} ${b.role.toUpperCase()}: ${oneLine(note, 140)}${userSaid ? ` (the user: "${oneLine(userSaid, 80)}")` : ""} → ${file}`);
  timeline(state, "RESUME", `${b.call} runs again`);
  verdict(state, `Permission ${id} for ${b.role.toUpperCase()}`, "DENKEN", decision === "grant" ? "GRANTED" : "DENIED", `${what}: ${note}`, { call: b.call, file });
  assertLock();
  appendFileSync(join(runDir, "rulings.md"), `${existsSync(join(runDir, "rulings.md")) ? "" : "# Rulings\n\n"}## ${id} · permission · ${b.role.toUpperCase()} · ${decision === "grant" ? `granted ${what}` : `denied ${what}`}\n\n${note}\n\n`);
  const { stage, role, mode, round, attempt } = b.callInfo;
  state.retryCall = { stage, role, mode, round, attempt: attempt + 1 };
  if (mode === "work") state.pending = "work";
  state.denialStreak[stage] = 0;
  state.blocked = null;
  save(runDir, state);
  print({ action: decision === "grant" ? "granted" : "denied", id, role, what, next: `${b.call} runs again. Run next with --wait.` });
}

// After a secrets stop: rescan once the files are cleaned up, or accept the findings on the
// user's word (false positives). Either way the run then finishes.
export function cmdSecrets(runDir, args) {
  const state = load(runDir);
  if (state.blocked?.reason !== "secrets_in_record") fail("nothing to do: the run is not stopped on secrets in the record");
  const i = args.indexOf("--user-said");
  const userSaid = i >= 0 ? String(args[i + 1] ?? "").trim() : "";
  if (args.includes("--accept")) {
    if (!userSaid) fail("accepting the findings needs the user's words: --accept --user-said '<verbatim>'");
    state.secretsAccepted = { at: now(), userSaid, findings: state.secretFindings };
    timeline(state, "USER via DENKEN", `accepted ${state.secretFindings.length} secret-scan finding(s) as safe: "${oneLine(userSaid, 120)}"`);
  } else if (args.includes("--rescan")) {
    state.secretFindings = scanSecrets(state);
    if (state.secretFindings.length) {
      assertLock();
      save(runDir, state);
      print({ action: "needs_user", reason: "secrets_in_record", findings: state.secretFindings, next: "Still found. Clean the files, then rescan, or accept with the user's words." });
      process.exit(1);
    }
    timeline(state, "ENGINE", "secret scan: clean after the files were cleaned up");
  } else fail("usage: secrets <run> --rescan | --accept --user-said '<verbatim>'");
  state.blocked = null;
  timeline(state, "ENGINE", "DONE: every stage approved");
  finish(state);
  enterStage(state, "done");
  assertLock();
  save(runDir, state);
  print(actionFor(runDir, state));
}

// DENKEN changes levels mid-run, for example to give a stage that keeps failing a stronger
// model; calls launched from now on use them.
export function cmdLevels(runDir, args) {
  const state = load(runDir);
  if (["intake", "done", "aborted"].includes(state.stage)) fail(`levels apply to a started run that is not finished (stage: ${state.stage}); at the start, pass them to start`);
  const noteIndex = args.indexOf("--note");
  const note = noteIndex >= 0 ? String(args[noteIndex + 1] ?? "").trim() : "";
  if (!note) fail('say why: levels <run> <stage or role>=<level>... [--model <role>=<id>] [--effort <role>=<value>] --note "<why>"');
  const before = roleAgents(state);
  const next = parseChoices(args, state);
  const problems = choiceProblems({ ...state, ...next });
  if (problems.length) fail(problems.join("; "));
  Object.assign(state, next);
  const after = roleAgents(state);
  const changed = Object.keys(after).filter((r) => agentLabel(after[r]) !== agentLabel(before[r])).map((r) => `${r.toUpperCase()} ${agentLabel(before[r])} → ${agentLabel(after[r])}`);
  if (!changed.length) fail("nothing changes: every role already runs as asked");
  timeline(state, "DENKEN", `levels changed for the calls from now on: ${changed.join("; ")}. ${oneLine(note, 200)}`);
  verdict(state, "Levels", "DENKEN", "SET", `${changed.join("; ")}: ${note}`);
  assertLock();
  save(runDir, state);
  print({ action: "levels", roles: after, next: "Calls launched from now on use these. Run next with --wait." });
}
