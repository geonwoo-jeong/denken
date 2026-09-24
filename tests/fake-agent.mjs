#!/usr/bin/env node
// Stand-in for the claude and codex CLIs in tests, scripted by the JSON file in $FAKE_SCENARIO.
// Scenario keys are "<stage>-<role>-<round>". A value is one step, or an array of steps for
// successive attempts of the same call. A step can set:
//   review | qa   the structured final message (default: approve / pass every Q item)
//   todoDev       text METHODE writes to todo-dev.md (default covers S1 and S2)
//   todoQa        text METHODE writes to todo-qa.md (default covers S1 and S2)
//   tick          D ids STARK ticks off with the tick command (default: all of them)
//   tickFail      D ids whose tick command fails (they stay unticked)
//   tickArgs      the argv STARK passes to the tick command (default: echo ok)
//   tickByHand    D ids STARK ticks by editing todo-dev.md directly, with no test run
//   untickByHand  D ids STARK unticks by editing todo-dev.md directly
//   tickOther     a non-D id (like "Q1") whose checkbox STARK ticks by hand in the TODO section
//   editFiles     { path: content } STARK writes in the project before ticking
//   report        text STARK writes to dev-report.md
//   touch         a path to append to, relative to the project ("$RUN" is the run directory)
//   fail          exit 1 with this text on stderr
//   denials       permission denials to report (claude only)
//   sleepMs       wait this long before answering
//   spawnLate     { afterMs, touch }: leave a background process that appends to `touch` later
//   staleMeta     write a result file from another attempt of this call before answering
// Each call is logged as "<cli> <key> <ro|rw> <net|nonet|->".
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const DEFAULT_TODO_DEV = "# Development TODO\n\n## Acceptance\n- S1. One. Done when: one works.\n- S2. Two. Done when: two works.\n\n## Do not build\n- X1. Three.\n\n## TODO\n- [ ] D1 (S1) build one\n- [ ] D2 (S2) build two\n\n## Open questions\n- None\n";
export const DEFAULT_TODO_QA = "# QA TODO\n\n## Checks\n- [ ] Q1 (S1) check one\n- [ ] Q2 (S2) check two\n";
const pass = (id) => ({ id, spec_item: id, check: `check ${id}`, how_verified: "fake", result: "PASS", evidence: "ok", reproduce: null });

const cli = basename(process.argv[1]);
const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const scenarioPath = process.env.FAKE_SCENARIO;
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

const role = prompt.match(/^# (\w+):/m)[1].toLowerCase();
const [, stage, round] = prompt.match(/- Stage: (\w+), round (\d+)/);
const runDir = prompt.match(/- Run directory: (.+)/)[1];
const key = `${stage}-${role}-${round}`;
const readOnly = args.includes("read-only") || args.includes("dontAsk");
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
  writeFileSync(join(runDir, "calls", `${key}.meta.json`), JSON.stringify({ status: "ok", nonce: "earlier-attempt" }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
}
if (step.touch) {
  const target = step.touch.replace("$RUN", runDir);
  appendFileSync(isAbsolute(target) ? target : join(process.cwd(), target), "tampered\n");
}
if (step.fail) {
  process.stderr.write(step.fail);
  process.exit(1);
}

let final;
if (["richter", "ubel", "frieren"].includes(role)) final = step.review ?? { verdict: "APPROVED", findings: [], checked: ["fake review"] };
else if (role === "genau") final = step.qa ?? { result: "PASS", items: [pass(1), pass(2)] };
else {
  const writes = (prompt.match(/- Write:\n((?: {2}- .+\n?)+)/)?.[1] ?? "").split("\n").map((l) => l.replace(/^ {2}- /, "").trim()).filter(Boolean);
  for (const file of writes) {
    const name = basename(file);
    const content = name === "todo-dev.md" ? step.todoDev ?? DEFAULT_TODO_DEV : name === "todo-qa.md" ? step.todoQa ?? DEFAULT_TODO_QA : name === "dev-report.md" && step.report ? step.report : `# ${role} round ${round}\n`;
    writeFileSync(file, content);
  }
  if (stage === "dev") {
    appendFileSync(join(process.cwd(), "src.txt"), `change ${round}\n`);
    for (const [path, content] of Object.entries(step.editFiles ?? {})) {
      mkdirSync(dirname(join(process.cwd(), path)), { recursive: true });
      writeFileSync(join(process.cwd(), path), content);
    }
    // Tick D items off through the engine's tick command, as STARK does once an item's tests pass.
    const todo = join(runDir, "todo-dev.md");
    const [, script] = prompt.match(/node "([^"]+)" tick "/);
    const ids = [...readFileSync(todo, "utf8").matchAll(/^\s*[-*]\s*\[[ xX]\]\s*D(\d+)\b/gm)].map((m) => Number(m[1]));
    for (const id of ids.filter((id) => !step.tick || step.tick.includes(id))) {
      if (step.tickByHand?.includes(id)) continue;
      spawnSync(process.execPath, [script, "tick", runDir, `D${id}`, "--", ...(step.tickFail?.includes(id) ? ["false"] : step.tickArgs ?? ["echo", "ok"])], { stdio: "ignore" });
    }
    const setBox = (id, box) => writeFileSync(todo, readFileSync(todo, "utf8").replace(new RegExp(`^(\\s*[-*]\\s*)\\[[ xX]\\](\\s*${id}\\b)`, "m"), `$1[${box}]$2`));
    for (const id of step.tickByHand ?? []) setBox(`D${id}`, "x");
    for (const id of step.untickByHand ?? []) setBox(`D${id}`, " ");
    if (step.tickOther) setBox(step.tickOther, "x");
  }
  if (stage === "wiki") appendFileSync(join(process.cwd(), "docs.md"), `doc ${round}\n`);
  final = `${role} wrote ${writes.join(", ")}`;
}

const text = typeof final === "string" ? final : JSON.stringify(final);
if (cli === "claude") {
  const sessionId = args[args.indexOf("--session-id") + 1];
  const structured = typeof final === "string" ? null : final;
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
  console.log(JSON.stringify({ type: "result", is_error: false, result: text, structured_output: structured, session_id: sessionId, permission_denials: step.denials ?? [] }));
} else {
  writeFileSync(args[args.indexOf("-o") + 1], text);
  console.log(JSON.stringify({ type: "thread.started", thread_id: `thread-${key}` }));
}
