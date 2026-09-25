#!/usr/bin/env node
// Stand-in for the claude and codex CLIs in tests, scripted by the JSON file in $FAKE_SCENARIO.
// Scenario keys are "<stage>-<role>-<round>", or "<unit>:<stage>-<role>-<round>" for a unit's
// calls (UNIT-1:dev-stark-1). A value is one step, or an array of steps for successive attempts
// of the same call. In a unit, METHODE plans from the unit's request.md and STARK works in the
// unit's scope (<first scope folder>/work.txt). A step can set:
//   review | qa   the structured final message (default: approve / pass every QA item)
//   todoDev       text METHODE writes to todo-dev.md (default covers REQ-001 and REQ-002)
//   todoQa        text METHODE writes to todo-qa.md (default covers REQ-001 and REQ-002)
//   tick          DEV numbers STARK ticks off with the tick command (default: all of them)
//   tickFail      DEV numbers whose tick command fails (they stay unticked)
//   evidence      the evidence STARK passes to the tick command (default: changed src.txt)
//   noChange      { DEV number: reason } items STARK ticks with --no-change instead of --evidence
//   fixEvidence   the evidence STARK passes when ticking FIX items (default: fixed the cause in src.txt)
//   tickArgs      the argv STARK passes to the tick command (default: echo ok)
//   fixTick       false: STARK leaves the recovery (FIX) items unticked
//   tickByHand    DEV numbers STARK ticks by editing todo-dev.md directly
//   untickByHand  DEV numbers STARK unticks by editing todo-dev.md directly
//   tickOther     a non-DEV label (like "note") whose checkbox STARK ticks by hand in the TODO section
//   editTodo      [[from, to], ...] text STARK replaces by hand in todo-dev.md, after ticking
//   forgeTicks    [{ item, evidence, log? }] tick records STARK writes by hand, skipping the tick command
//   editFiles     { path: content } a worker writes in the project (STARK: before ticking)
//   removeFiles   paths a worker deletes from the project
//   appendFiles   { path: text } a worker appends to files in the project
//   requestPermission { need, why }: ask DENKEN for a permission, then stop
//   evidenceText  extra text GENAU puts in each evidence file
//   report        text STARK writes to dev-report.md
//   touch         a path to append to, relative to the project ("$RUN" is the run directory,
//                 "$PROJ" the main project, where units are merged)
//   devFiles      in a unit: the files METHODE's DEV items name (default: <scope>/work.txt)
//   modelRan      the model the CLI reports it ran (default: the --model asked for, "-resolved")
//   fail          exit 1 with this text on stderr
//   denials       permission denials to report (claude only)
//   sleepMs       wait this long before answering
//   spawnLate     { afterMs, touch }: leave a background process that appends to `touch` later
//   staleMeta     write a result file from another attempt of this call before answering
// Each call is logged as "<cli> <key> <ro|rw> <net|nonet|->".
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const DEFAULT_TODO_DEV = "# Development TODO\n\n## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) build one\n- [ ] DEV-002 (REQ-002) build two\n\n## Open questions\n- None\n";
export const DEFAULT_TODO_QA = "# QA TODO\n\n## Checks\n- [ ] QA-001 (REQ-001) check one\n- [ ] QA-002 (REQ-002) check two\n";
const pad = (n) => String(n).padStart(3, "0");
const pass = (n) => ({ id: `QA-${pad(n)}`, request_item: `REQ-${pad(n)}`, check: `check ${n}`, how_verified: "fake", result: "PASS", evidence: "ok", reproduce: null });

const cli = basename(process.argv[1]);
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log(`${cli} 0.0.0-fake`);
  process.exit(0);
}
// Claude gets the role's instructions as an appended system prompt, and this call's facts on stdin.
const system = args.includes("--append-system-prompt-file") ? readFileSync(args[args.indexOf("--append-system-prompt-file") + 1], "utf8") : "";
const prompt = `${system}\n${readFileSync(0, "utf8")}`;
const scenarioPath = process.env.FAKE_SCENARIO;
// A re-warm of a seed: a fork with nothing to do.
if (!/^# \w+:/m.test(prompt)) {
  appendFileSync(`${scenarioPath}.log`, `${cli} rewarm\n`);
  appendFileSync(`${scenarioPath}.args.jsonl`, `${JSON.stringify({ key: "rewarm", attempt: 1, args })}\n`);
  const sessionId = args[args.indexOf("--session-id") + 1];
  const structured = prompt.match(/Answer exactly: (\{.*\})/)?.[1];
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "fake-resolved" }));
  console.log(JSON.stringify({ type: "result", is_error: false, result: structured ?? "READY", structured_output: structured ? JSON.parse(structured) : null, session_id: sessionId, permission_denials: [] }));
  process.exit(0);
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

const role = prompt.match(/^# (\w+):/m)[1].toLowerCase();
// FLAMME's seed calls name the stage and the role they seed, not a round.
const [, stage, round = "0"] = prompt.match(/- Stage: (\w+)(?:, round (\d+))?/);
const seedFor = prompt.match(/^- Seed for: (\w+)/m)?.[1] ?? null;
const runDir = prompt.match(/- Run directory: (.+)/)[1];
const unit = prompt.match(/^- Unit: (UNIT-\d+)/m)?.[1] ?? null;
const callId = seedFor ? `${stage}-flamme-${seedFor}` : `${stage}-${role}-${round}`;
const key = `${unit ? `${unit}:` : ""}${callId}`;
// In a unit, the file STARK works on: <first scope folder>/work.txt, or the first scope file.
const request = existsSync(join(runDir, "request.md")) ? readFileSync(join(runDir, "request.md"), "utf8") : "";
const scopeFirst = request.match(/^- Scope: `([^`]+)`/m)?.[1];
const devFile = unit ? (scopeFirst.endsWith("/") ? `${scopeFirst}work.txt` : scopeFirst) : "src.txt";
// A Codex fork sets its sandbox with -c sandbox_mode="...".
const readOnly = args.includes("read-only") || args.includes('sandbox_mode="read-only"') || args.includes("dontAsk");
const network = readOnly
  ? "-"
  : cli === "codex"
    ? args.includes("sandbox_workspace_write.network_access=true") ? "net" : "nonet"
    : JSON.parse(args[args.indexOf("--settings") + 1]).sandbox.network?.strictAllowlist ? "nonet" : "net";

const countsPath = `${scenarioPath}.counts.json`;
const counts = existsSync(countsPath) ? JSON.parse(readFileSync(countsPath, "utf8")) : {};
const attempt = (counts[key] = (counts[key] ?? 0) + 1);
writeFileSync(countsPath, JSON.stringify(counts));
appendFileSync(`${scenarioPath}.log`, `${cli} ${key} ${readOnly ? "ro" : "rw"} ${network}\n`);
appendFileSync(`${scenarioPath}.args.jsonl`, `${JSON.stringify({ key, attempt, args })}\n`);

const entry = scenario[key];
const step = (Array.isArray(entry) ? entry[attempt - 1] : entry) ?? {};

if (step.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.sleepMs);
// Leave a background process behind that touches a file later, like a stray dev server.
if (step.spawnLate) {
  const target = join(process.cwd(), step.spawnLate.touch);
  spawn(process.execPath, ["-e", `setTimeout(() => require("fs").appendFileSync(${JSON.stringify(target)}, "late\\n"), ${step.spawnLate.afterMs})`], { stdio: "ignore" }).unref();
}
// Write a finished-looking result from some other attempt of this call, then keep working.
if (step.staleMeta) {
  writeFileSync(join(runDir, "calls", `${callId}.meta.json`), JSON.stringify({ status: "ok", nonce: "earlier-attempt" }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
if (step.touch) {
  const target = step.touch.replace("$RUN", runDir).replace("$PROJ", join(dirname(scenarioPath), "proj"));
  appendFileSync(isAbsolute(target) ? target : join(process.cwd(), target), "tampered\n");
}
if (step.fail) {
  process.stderr.write(step.fail);
  process.exit(1);
}

let final;
if (role === "flamme") {
  // A seed: read, then answer as the call it seeds must (JSON when a schema is attached).
  const schema = args.includes("--json-schema") ? args[args.indexOf("--json-schema") + 1] : args.includes("--output-schema") ? readFileSync(args[args.indexOf("--output-schema") + 1], "utf8") : null;
  final = !schema ? `brief for ${seedFor}` : schema.includes('"findings"') ? { verdict: "CONTEXT_LOADED", summary: `Context loaded for ${seedFor}.`, findings: [], checked: ["fake seed"] } : { result: "CONTEXT_LOADED", summary: "Context loaded.", items: [] };
} else if (step.requestPermission) {
  // Ask DENKEN for a permission through the engine, then stop, as the role files say.
  const [, script] = prompt.match(/node "([^"]+)" request-permission "/);
  spawnSync(process.execPath, [script, "request-permission", runDir, "--need", step.requestPermission.need, "--why", step.requestPermission.why], { stdio: "ignore" });
  final = `stopped: asked for ${step.requestPermission.need}`;
} else if (["richter", "ubel", "frieren"].includes(role)) final = step.review ?? { verdict: "APPROVED", summary: `${role} found nothing to change`, findings: [], checked: ["fake review"] };
else if (role === "genau") {
  // Leave an evidence file per item, as GENAU does, and point to it from the report.
  final = step.qa ?? { result: "PASS", summary: "every check passed on the running product", items: listedChecks() ?? [pass(1), pass(2)] };
  const evidence = join(runDir, "calls", `${callId}.evidence`);
  mkdirSync(evidence, { recursive: true });
  for (const item of final.items) {
    writeFileSync(join(evidence, `${item.id}.txt`), `${item.id}: ${item.result}\n${step.evidenceText ?? ""}`);
    item.evidence_files = [join(evidence, `${item.id}.txt`)];
  }
}
else {
  const writes = (prompt.match(/- Write:\n((?: {2}- .+\n?)+)/)?.[1] ?? "").split("\n").map((l) => l.replace(/^ {2}- /, "").trim()).filter(Boolean);
  const planned = unit ? planFromRequest(step) : null;
  for (const file of writes) {
    const name = basename(file);
    const content = name === "todo-dev.md" ? step.todoDev ?? planned?.dev ?? DEFAULT_TODO_DEV : name === "todo-qa.md" ? step.todoQa ?? planned?.qa ?? DEFAULT_TODO_QA : name === "dev-report.md" && step.report ? step.report : `# ${role} round ${round}\n`;
    writeFileSync(file, content);
  }
  for (const [path, content] of Object.entries(step.editFiles ?? {})) {
    mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
    writeFileSync(join(process.cwd(), path), content);
  }
  for (const path of step.removeFiles ?? []) rmSync(join(process.cwd(), path), { force: true });
  for (const [path, text] of Object.entries(step.appendFiles ?? {})) appendFileSync(join(process.cwd(), path), text);
  if (stage === "dev") {
    mkdirSync(dirname(join(process.cwd(), devFile)), { recursive: true });
    appendFileSync(join(process.cwd(), devFile), `change ${round}\n`);
    // Tick DEV items off through the engine's tick command, as STARK does once an item's tests pass.
    const todo = join(runDir, "todo-dev.md");
    const [, script] = prompt.match(/node "([^"]+)" tick "/);
    const ids = [...readFileSync(todo, "utf8").matchAll(/^\s*[-*]\s*\[[ xX]\]\s*DEV-(\d{3,})\b/gm)].map((m) => Number(m[1]));
    for (const id of ids.filter((id) => !step.tick || step.tick.includes(id))) {
      if (step.tickByHand?.includes(id)) continue;
      const why = step.noChange?.[id] ? ["--no-change", step.noChange[id]] : ["--evidence", step.evidence ?? `changed ${devFile}`];
      spawnSync(process.execPath, [script, "tick", runDir, `DEV-${pad(id)}`, ...why, "--", ...(step.tickFail?.includes(id) ? ["false"] : step.tickArgs ?? ["echo", "ok"])], { stdio: "ignore" });
    }
    // Recovery items of the latest QA cycle, when there are any.
    const fix = join(runDir, "todo-fix.md");
    if (existsSync(fix)) {
      const latest = readFileSync(fix, "utf8").split(/^## QA cycle \d+/m).at(-1);
      for (const m of latest.matchAll(/^\s*[-*]\s*\[ \]\s*(FIX-\d{3,})\b/gm)) {
        if (step.fixTick === false) break;
        spawnSync(process.execPath, [script, "tick", runDir, m[1], "--evidence", step.fixEvidence ?? `fixed the cause in ${devFile}`, "--", "echo", "fixed"], { stdio: "ignore" });
      }
    }
    const setBox = (id, box) => writeFileSync(todo, readFileSync(todo, "utf8").replace(new RegExp(`^(\\s*[-*]\\s*)\\[[ xX]\\](\\s*${id}\\b)`, "m"), `$1[${box}]$2`));
    for (const id of step.tickByHand ?? []) setBox(`DEV-${pad(id)}`, "x");
    for (const id of step.untickByHand ?? []) setBox(`DEV-${pad(id)}`, " ");
    if (step.tickOther) setBox(step.tickOther, "x");
    for (const [from, to] of step.editTodo ?? []) writeFileSync(todo, readFileSync(todo, "utf8").replace(from, to));
    // A forged record: a passing-looking log and a ledger line whose sha matches it.
    for (const f of step.forgeTicks ?? []) {
      const log = f.log ?? `${callId}.tick-${f.item}.log`;
      const text = "$ echo ok\n--- stdout ---\nok\n\n--- stderr ---\n\n[exit 0]\n";
      writeFileSync(join(runDir, "calls", log), text);
      const logSha = createHash("sha256").update(text).digest("hex");
      appendFileSync(join(runDir, "calls", `${callId}.ticks.jsonl`), `${JSON.stringify({ item: f.item, command: "echo ok", evidence: f.evidence, noChange: false, exitCode: 0, at: new Date().toISOString(), lastLine: "ok", log, logSha })}\n`);
    }
  }
  if (stage === "wiki") appendFileSync(join(process.cwd(), "docs.md"), `doc ${round}\n`);
  final = `${role} wrote ${writes.join(", ")}`;
}

const text = typeof final === "string" ? final : JSON.stringify(final);
if (cli === "claude") {
  const sessionId = args[args.indexOf("--session-id") + 1];
  const structured = typeof final === "string" ? null : final;
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "fake-default";
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: step.modelRan ?? `${model}-resolved` }));
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 300, cache_creation_input_tokens: 100 };
  console.log(JSON.stringify({ type: "result", is_error: false, result: text, structured_output: structured, session_id: sessionId, permission_denials: step.denials ?? [], usage, total_cost_usd: 0.01 }));
} else {
  writeFileSync(args[args.indexOf("-o") + 1], text);
  console.log(JSON.stringify({ type: "thread.started", thread_id: `thread-${key}` }));
}

// A passing answer for every QA item listed in todo-qa.md.
function listedChecks() {
  const path = join(runDir, "todo-qa.md");
  if (!existsSync(path)) return null;
  const items = [...readFileSync(path, "utf8").matchAll(/^- \[[ xX]\] (QA-\d{3,}) \(([^)]*)\)\s*(.*)$/gm)];
  return items.length ? items.map(([, id, refs, text]) => ({ id, request_item: refs.match(/REQ-\d{3,}/)?.[0] ?? null, check: text.slice(0, 60), how_verified: "fake", result: "PASS", evidence: "ok", reproduce: null })) : null;
}

// A unit's TODO lists, written from its request.md the way METHODE would: every item copied, one
// DEV and one QA item per REQ item, numbered from the unit's first number.
function planFromRequest(step) {
  const part = (heading) => (request.split(new RegExp(`^## ${heading}\\s*$`, "m"))[1] ?? "").split(/^## /m)[0];
  const items = (heading, prefix) => part(heading).split("\n").filter((l) => new RegExp(`^- ${prefix}-\\d{3,}`).test(l));
  const first = Number(request.match(/Number this unit's items from (\d+)/)?.[1] ?? 1);
  const reqs = items("Confirmed", "REQ").map((l) => [l, l.match(/REQ-\d{3,}/)[0]]);
  const files = (step.devFiles ?? [devFile]).map((f) => `\`${f}\``).join(", ");
  const dev = reqs.map(([, r], i) => `- [ ] DEV-${pad(first + i)} (${r}) build ${r}. Files: ${files}.`);
  const qa = reqs.map(([, r], i) => `- [ ] QA-${pad(first + i)} (${r}) check ${r}`);
  return {
    dev: `# Development TODO\n\n## Acceptance\n${reqs.map(([l]) => l).join("\n")}\n\n## Do not build\n${[...items("Out of scope", "OUT"), ...items("Not now", "LATER")].join("\n")}\n\n## Cautions\n${items("Cautions", "CAUTION").join("\n")}\n\n## Approach\nBuild it in ${devFile}.\n\n## TODO\n${dev.join("\n")}\n\n## Open questions\n- None\n`,
    qa: `# QA TODO\n\n## Checks\n${qa.join("\n")}\n`,
  };
}
