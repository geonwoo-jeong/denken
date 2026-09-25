#!/usr/bin/env node
/*
 * Stand-in for the claude and codex CLIs in tests, scripted by the JSON file in $FAKE_SCENARIO.
 * Scenario keys are "<stage>-<role>-<round>", or "<unit>:<stage>-<role>-<round>" for a unit's
 * calls (UNIT-1:dev-stark-1). A value is one step, or an array of steps for successive attempts
 * of the same call. In a unit, METHODE plans from the unit's request.md and STARK works in the
 * unit's scope (<first scope folder>/work.txt). A step can set:
 *   review | qa   the structured final message (default: approve / pass every QA item)
 *   todoDev       text METHODE writes to todo-dev.md (default covers REQ-001 and REQ-002)
 *   todoQa        text METHODE writes to todo-qa.md (default covers REQ-001 and REQ-002)
 *   tick          DEV numbers STARK ticks off with the tick command (default: all of them)
 *   tickFail      DEV numbers whose tick command fails (they stay unticked)
 *   evidence      the evidence STARK passes to the tick command (default: changed src.txt)
 *   noChange      { DEV number: reason } items STARK ticks with --no-change instead of --evidence
 *   fixEvidence   the evidence STARK passes when ticking FIX items (default: fixed the cause in src.txt)
 *   tickArgs      the argv STARK passes to the tick command (default: echo ok)
 *   fixTick       false: STARK leaves the recovery (FIX) items unticked
 *   tickByHand    DEV numbers STARK ticks by editing todo-dev.md directly
 *   untickByHand  DEV numbers STARK unticks by editing todo-dev.md directly
 *   tickOther     a non-DEV label (like "note") whose checkbox STARK ticks by hand in the TODO section
 *   editTodo      [[from, to], ...] text STARK replaces by hand in todo-dev.md, after ticking
 *   forgeTicks    [{ item, evidence, log? }] tick records STARK writes by hand, skipping the tick command
 *   editFiles     { path: content } a worker writes in the project (STARK: before ticking)
 *   removeFiles   paths a worker deletes from the project
 *   linkFiles     { path: target } paths a worker replaces by symlinks to the target ("$RUN/" starts
 *                 a path in the run directory)
 *   hardLinkFiles { path: target } paths a worker replaces by hard links to the target file
 *   appendFiles   { path: text } a worker appends to files in the project
 *   requestPermission { need, why }: ask DENKEN for a permission, then stop
 *   evidenceText  extra text GENAU puts in each evidence file
 *   report        text STARK writes to dev-report.md
 *   touch         a path to append to, relative to the project ("$RUN" is the run directory,
 *                 "$PROJ" the main project, where units are merged)
 *   devFiles      in a unit: the files METHODE's DEV items name (default: <scope>/work.txt)
 *   modelRan      the model the CLI reports it ran (default: the --model asked for, "-resolved")
 *   fail          exit 1 with this text on stderr
 *   denials       permission denials to report (claude only)
 *   sleepMs       wait this long before answering
 *   spawnLate     { afterMs, touch }: leave a background process that appends to `touch` later
 *   staleMeta     write a result file from another attempt of this call before answering
 * Each call is logged as "<cli> <key> <ro|rw> <net|nonet|->".
 */
import { runFake } from "./fake-main.ts";

await runFake();
