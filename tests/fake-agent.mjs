#!/usr/bin/env node
// Stand-in for the claude and codex CLIs in tests, scripted by the JSON file in $FAKE_SCENARIO.
// Scenario keys are "<stage>-<role>-<round>". A value is one step, or an array of steps for
// successive attempts of the same call. A step can set:
//   review | qa   the structured final message (default: approve / pass)
//   touch         a path to append to, relative to the project ("$RUN" is the run directory)
//   fail          exit 1 with this text on stderr
//   denials       permission denials to report (claude only)
//   sleepMs       wait this long before answering
//   spawnLate     { afterMs, touch }: leave a background process that appends to `touch` later
//   staleMeta     write a result file from another attempt of this call before answering
// Each call is logged as "<cli> <key> <ro|rw> <net|nonet|->".
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

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
if (role === "richter") final = step.review ?? { verdict: "APPROVED", findings: [], checked: ["fake review"] };
else if (role === "genau") final = step.qa ?? { result: "PASS", criteria: [{ id: 1, criterion: "c1", how_verified: "fake", result: "PASS", evidence: "ok", reproduce: null }] };
else {
  const artifact = prompt.match(/- Write:\n {2}- (.+)/)[1];
  writeFileSync(artifact, `# ${role} round ${round}\n`);
  if (stage === "dev") appendFileSync(join(process.cwd(), "src.txt"), `change ${round}\n`);
  if (stage === "wiki") appendFileSync(join(process.cwd(), "docs.md"), `doc ${round}\n`);
  final = `${role} wrote ${artifact}`;
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
