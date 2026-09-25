#!/usr/bin/env node
// DENKEN run engine: a deterministic state machine for the stage loop.
// DENKEN (the LLM) handles intake, rulings and talking to the user. This script handles the rest:
// which call runs next, launching it as a separate agent process, guarding files, parsing
// verdicts, counting repeated topics, and every write to state.json.
//
//   node denken.mjs new <slug>                  create .denken/runs/<id>/ and print its path
//   node denken.mjs start <run>                 check request.md, snapshot the role assignment, begin plan
//   node denken.mjs confirm <run> --user-said <text>   the user approved the scope and TODO lists; begin dev
//   node denken.mjs next <run> [--wait <sec>]   advance the run; prints one JSON action
//   node denken.mjs rule <run> --decision <uphold|dismiss|replan|abort> (--note <text> | --note-file <path>)
//                   [--identities <a,b>]        which open findings a dismissal covers
//   (start, next, rule and retry take a per-run lock, so only one engine process works on a run.)
//   node denken.mjs retry <run>                 resume after a needs_user block
//   node denken.mjs status <run>                compact summary
//   node denken.mjs tick <run> DEV-001|FIX-001 (--evidence <text> | --no-change <why>) -- <cmd> <args...>
//                   STARK, during its call: check the evidence, run the item's tests, and on success
//                   record the tick; the engine writes it into the TODO file when the call ends
//   node denken.mjs request-permission <run> --need <what> --why <why>   a worker or GENAU, during its call
//   node denken.mjs grant <run> [--network] [--dir <path>]... [--tool <pattern>]... --note <text>
//   node denken.mjs deny <run> --note <text>    DENKEN's answer to a permission request; the call runs again
//   node denken.mjs secrets <run> --rescan | --accept --user-said <text>   after a secrets_in_record stop
//
// Actions printed by next: running | needs_ruling | needs_user | done | aborted.
// Run files: request.md (DENKEN) -> todo-dev.md + todo-qa.md (METHODE) -> user confirms -> dev, qa, wiki.
// Run from the project root.
//
// This file only reads the command line and dispatches. The engine is in lib/: the stage loop
// (flow, ingest, stages, findings), the calls (calls, cli, exec), the files a run keeps (state,
// request, todo, record), the guards (guard, lock, git), and each feature on its own (ticks, units
// and parallel, seeds and sessions, levels, wiki, scope).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cmdRequestPermission, cmdTick } from "./lib/cmd-agent.mjs";
import { cmdConfirm, cmdLevels, cmdPermissionDecision, cmdRetry, cmdRule, cmdSecrets } from "./lib/cmd-decide.mjs";
import { cmdNew, cmdStart, cmdStatus } from "./lib/cmd-run.mjs";
import { fail, print, SCRIPT } from "./lib/core.mjs";
import { execCall, writeMeta } from "./lib/exec.mjs";
import { next } from "./lib/flow.mjs";
import { acquireLock } from "./lib/lock.mjs";
import { stopUnitRun } from "./lib/parallel.mjs";
import { callBase, load, runDirOf } from "./lib/state.mjs";

const [command, runArg, ...rest] = process.argv.slice(2);
const locked = async (fn) => {
  const runDir = runDirOf(runArg);
  if (!(await acquireLock(runDir, 0))) fail("another DENKEN engine process is working on this run; wait for it, then try again");
  fn(runDir);
};
// A command for one unit goes through the parent run, which alone says where the unit lives.
const unitAt = rest.indexOf("--unit");
if (unitAt >= 0 && ["rule", "retry", "confirm", "grant", "deny", "status", "secrets", "levels"].includes(command)) {
  const parent = load(runDirOf(runArg));
  const u = (parent.units ?? []).find((x) => x.id === rest[unitAt + 1]);
  if (!u) fail(`${rest[unitAt + 1] ?? "(none)"} is not a unit of this run${parent.units ? `; its units are ${parent.units.map((x) => x.id).join(", ")}` : ""}`);
  if (!existsSync(u.run)) fail(`${u.id}'s worktree is gone: the units were merged, or the run was cleaned up`);
  const r = spawnSync(process.execPath, [SCRIPT, command, u.run, ...rest.filter((_, i) => i !== unitAt && i !== unitAt + 1)], { cwd: u.root, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
switch (command) {
  case "_abort":
    await stopUnitRun(runDirOf(runArg));
    break;
  case "new":
    cmdNew(runArg);
    break;
  case "start":
    await locked((runDir) => cmdStart(runDir, rest));
    break;
  case "levels":
    await locked((runDir) => cmdLevels(runDir, rest));
    break;
  case "next": {
    const i = rest.indexOf("--wait");
    const waitSec = i >= 0 ? Number(rest[i + 1]) || 0 : 0;
    const runDir = runDirOf(runArg);
    if (!(await acquireLock(runDir, waitSec * 1000))) {
      print({ action: "running", busy: true, next: "Another DENKEN engine process is waiting on this run. Run next again with --wait." });
      break;
    }
    await next(runDir, waitSec);
    break;
  }
  case "rule":
    await locked((runDir) => cmdRule(runDir, rest));
    break;
  case "retry":
    await locked(cmdRetry);
    break;
  case "confirm":
    await locked((runDir) => cmdConfirm(runDir, rest));
    break;
  case "status":
    cmdStatus(runDirOf(runArg));
    break;
  case "tick":
    cmdTick(runDirOf(runArg), rest);
    break;
  case "request-permission":
    cmdRequestPermission(runDirOf(runArg), rest);
    break;
  case "secrets":
    await locked((runDir) => cmdSecrets(runDir, rest));
    break;
  case "grant":
  case "deny":
    await locked((runDir) => cmdPermissionDecision(runDir, rest, command));
    break;
  case "_exec":
    try {
      await execCall(runArg, rest[0]);
    } catch (e) {
      const base = callBase(runArg, rest[0]);
      let nonce = null;
      try {
        nonce = JSON.parse(readFileSync(`${base}.job.json`, "utf8")).nonce;
      } catch {}
      writeMeta(base, { status: "failed", nonce, error: `runner error: ${e.message}`, finished: now() });
    }
    break;
  default:
    fail("usage: denken.mjs <new|start|next|confirm|rule|retry|grant|deny|status|tick|request-permission> ...");
}
