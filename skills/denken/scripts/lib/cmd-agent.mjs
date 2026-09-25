// Commands an agent runs during its call: tick and request-permission.
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedSince } from "./changes.mjs";
import { fail, hashFile, now, print, ROOT, TODO_DEV, TODO_FIX } from "./core.mjs";
import { callBase, load, readRunFile } from "./state.mjs";
import { itemBase, namesFile } from "./ticks.mjs";
import { fixItems, parseItems } from "./todo.mjs";

// `tick <run> <DEV-001|FIX-001> --evidence "<what was done, and where>" -- <command> <args...>`:
// run by STARK, inside its own sandbox, during its call. No evidence, no tick: the evidence must
// name a file this stage changed.
export function cmdTick(runDir, args) {
  const state = load(runDir);
  const call = state.inflight;
  if (call?.stage !== "dev" || call.mode !== "work") fail("tick is for STARK, during a development call");
  const item = String(args[0] ?? "");
  const sep = args.indexOf("--");
  const head = sep >= 0 ? args.slice(0, sep) : args;
  const option = (name) => (head.includes(name) ? String(head[head.indexOf(name) + 1] ?? "").trim() : "");
  const evidence = option("--evidence");
  const noChange = option("--no-change");
  // The command runs as the argv given, with no shell, so "|| true" or "; exit 0" cannot turn a
  // failure into a tick, and quoted arguments reach the test runner intact.
  const argv = sep >= 0 ? args.slice(sep + 1) : [];
  if (!/^(DEV|FIX)-\d{3,}$/.test(item) || !argv.length || !evidence === !noChange) {
    fail('usage: tick <run> <DEV-001|FIX-001> (--evidence "<what was done, and where>" | --no-change "<why the item needs no change>") -- <command> <args...>');
  }
  const prefix = item.split("-")[0];
  const d = (prefix === "DEV" ? parseItems(readRunFile(runDir, TODO_DEV), "DEV").items : fixItems(runDir).filter((f) => f.cycle === state.currentFixCycle)).find((x) => x.key === item);
  if (!d) fail(prefix === "DEV" ? `${item} is not an item in the TODO section of todo-dev.md` : `${item} is not a recovery item of the current QA cycle in todo-fix.md`);
  // The evidence must name a file changed for this item: since its last tick, since the engine
  // unticked it, since its QA cycle, or since development began, whichever came last.
  const base = itemBase(runDir, state, item);
  const changed = changedSince(state, base.tree);
  const cited = evidence ? changed.filter((f) => namesFile(evidence, f)) : [];
  if (evidence && !cited.length) {
    fail(changed.length
      ? `the evidence must name a file changed for ${item} since ${base.what}. Changed since then: ${changed.join(", ")}`
      : `nothing has changed since ${base.what}. Build ${item} first; if it needs no change at all, tick it with --no-change "<why>" instead (UBEL reviews the reason).`);
  }
  const at = now();
  const command = argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
  const ledger = `${callBase(runDir, call.id)}.ticks.jsonl`;
  const log = `${call.id}.tick-${item}.log`;
  const r = spawnSync(argv[0], argv.slice(1), { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.error?.code === "ENOENT") {
    fail(`command not found: ${argv[0]}. Pass the command and its arguments as separate words after --, not as one quoted string; write sh -c '...' explicitly if you need a shell.`);
  }
  writeFileSync(join(runDir, "calls", log), `$ ${command}\n--- stdout ---\n${r.stdout ?? ""}\n--- stderr ---\n${r.stderr ?? ""}\n[exit ${r.status}]\n`);
  if (r.status !== 0) {
    print({ action: "not_ticked", item, exitCode: r.status, log: join(runDir, "calls", log), next: "Fix the failure, then run tick again." });
    process.exit(1);
  }
  // Record the test runner's pass/fail summary (e.g. "ℹ pass 10 / ℹ fail 0"), else stdout's last line.
  const out = ((r.stdout ?? "").trim() || (r.stderr ?? "").trim()).split("\n").filter(Boolean);
  const summary = out.filter((l) => /\b(pass(ed|es)?|fail(ed|ures?)?|tests?)\b/i.test(l)).slice(-2).join(" / ");
  const lastLine = (summary || out.at(-1) || "").slice(0, 160);
  const entry = { item, command, evidence: evidence || `No change needed: ${noChange}`, noChange: Boolean(noChange), cited, since: base.what, exitCode: 0, at, lastLine, log, logSha: hashFile(join(runDir, "calls", log)) };
  appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
  print({ action: "ticked", item, lastLine, next: `Recorded. The engine writes the tick and its evidence into ${prefix === "DEV" ? TODO_DEV : TODO_FIX} when this call ends. Go on to the next item.` });
}

// `request-permission <run> --need <what> --why <why>`: a worker or GENAU, during its call.
export function cmdRequestPermission(runDir, args) {
  const state = load(runDir);
  const call = state.inflight;
  if (!call || call.mode === "review") fail("request-permission is for a worker or GENAU, during its call");
  const value = (flag) => (args.indexOf(flag) >= 0 ? String(args[args.indexOf(flag) + 1] ?? "").trim() : "");
  const need = value("--need");
  const why = value("--why");
  if (!need || !why) fail('usage: request-permission <run> --need "<network | dir:<path> | tool:<pattern> | ...>" --why "<what it is for>"');
  appendFileSync(`${callBase(runDir, call.id)}.permission.jsonl`, `${JSON.stringify({ need, why, attempt: call.attempt, at: now() })}\n`);
  print({ action: "requested", need, next: "Stop now and end your turn with a one-line summary. DENKEN decides, then runs you again." });
}
