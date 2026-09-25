#!/usr/bin/env node
/*
 * DENKEN run engine: a deterministic state machine for the stage loop.
 * DENKEN (the LLM) handles intake, rulings and talking to the user. This script handles the rest:
 * which call runs next, launching it as a separate agent process, guarding files, parsing
 * verdicts, counting repeated topics, and every write to state.json.
 *
 *   node denken.ts new <slug>                  create .denken/runs/<id>/ and print its path
 *   node denken.ts start <run>                 check request.md, snapshot the role assignment, begin plan
 *   node denken.ts confirm <run> --user-said <text>   the user approved the scope and TODO lists; begin dev
 *   node denken.ts next <run> [--wait <sec>]   advance the run; prints one JSON action
 *   node denken.ts rule <run> --decision <uphold|dismiss|replan|abort> (--note <text> | --note-file <path>)
 *                   [--identities <a,b>]        which open findings a dismissal covers
 *   (start, next, rule and retry take a per-run lock, so only one engine process works on a run.)
 *   node denken.ts retry <run>                 resume after a needs_user block
 *   node denken.ts status <run>                compact summary
 *   node denken.ts tick <run> DEV-001|FIX-001 (--evidence <text> | --no-change <why>) -- <cmd> <args...>
 *                   STARK, during its call: check the evidence, run the item's tests, and on success
 *                   record the tick; the engine writes it into the TODO file when the call ends
 *   node denken.ts request-permission <run> --need <what> --why <why>   a worker or GENAU, during its call
 *   node denken.ts grant <run> [--network] [--dir <path>]... [--tool <pattern>]... --note <text>
 *   node denken.ts deny <run> --note <text>    DENKEN's answer to a permission request; the call runs again
 *   node denken.ts secrets <run> --rescan | --accept --user-said <text>   after a secrets_in_record stop
 *
 * Actions printed by next: running | needs_ruling | needs_user | done | aborted.
 * Run files: request.md (DENKEN) -> todo-dev.md + todo-qa.md (METHODE) -> user confirms -> dev, qa, wiki.
 * Run from the project root.
 *
 * This file only reads the command line and stops with the action an error carries. The engine is
 * in lib/: the stage loop (flow, ingest, stages, findings), the calls (call-*, cli, exec), the files a
 * run keeps (store, request, todo, record-*), the guards (guard, lock, git), and each feature on its
 * own (ticks, units and parallel, seeds and sessions, levels, wiki, scope). lib/entry.ts dispatches.
 */
import { EngineError } from "./lib/engine-error.ts";
import { print } from "./lib/output.ts";
import { runCommand } from "./lib/entry.ts";

const FIRST_ARG = 2,
  FAILURE = 1,
  [command = "", runArg = "", ...rest] = process.argv.slice(FIRST_ARG);

try {
  await runCommand(command, runArg, rest);
} catch (error) {
  if (!(error instanceof EngineError)) {
    throw error;
  }
  print(error.action);
  process.exitCode = FAILURE;
}
