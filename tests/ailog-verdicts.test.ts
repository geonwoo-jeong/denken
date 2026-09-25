// DENKEN engine tests: verdicts.md, written by the engine alone and saying both sides when they differ. Shared setup is in helpers.ts.
import type { JsonObject, TestRun } from "./test-types.ts";
import { changes, finding } from "./test-scenario.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";
import { writeFile } from "node:fs/promises";

// Where verdicts.md is, and what it said before anyone changed it.
interface Copy {
  readonly file: string;
  readonly original: string;
}

const KEPT = /→ (?<kept>raw\/verdicts\.changed-\d{14}\.md)/u,
  NIT = finding("style", { severity: "nonblocking" }),
  started = async (scenario: JsonObject): Promise<TestRun> => {
    const run = await setup(scenario),
      start = await run.denken("start", run.run);
    assert.equal(textAt(start.json, "action"), "started");
    return run;
  },
  logDir = async (run: TestRun): Promise<string> => {
    const state = await run.state();
    return path.join(run.proj, textAt(state, "log"));
  },
  keptOf = (text: string): string => {
    const match = KEPT.exec(text);
    if (match === null) {
      return "";
    }
    return (match.groups ?? {})["kept"] ?? "";
  },
  checkRestored = async (run: TestRun, copy: Copy): Promise<void> => {
    const now = await readOr(copy.file, ""),
      kept = keptOf(now),
      keptText = await readOr(path.join(await logDir(run), kept), "");
    assert.ok(now.startsWith(copy.original));
    assert.match(now, /\*\*RESTORED\*\* · verdicts\.md was changed outside the engine[^\n]* → raw\/verdicts\.changed-\d{14}\.md\n[^\n]*\*\*CONFIRMED\*\*/u);
    assert.notEqual(kept, "");
    assert.doesNotMatch(keptText, /REJECTED/u);
  },
  changedCopy = async (): Promise<void> => {
    const run = await started({ "plan-richter-1": changes(finding("scope", { file: "todo-dev.md" })) }),
      waiting = await run.drive({ autoConfirm: false }),
      file = path.join(await logDir(run), "verdicts.md"),
      original = await readOr(file, "");
    assert.equal(textAt(waiting, "reason"), "confirm_todos");
    // Someone deletes the rejection before the user confirms.
    await writeFile(
      file,
      original
        .split("\n")
        .filter((line) => !line.includes("REJECTED"))
        .join("\n"),
    );
    await run.denken("confirm", run.run, "--user-said", "Looks good, go ahead.");
    await checkRestored(run, { file, original });
  },
  reviewerDiffers = async (): Promise<void> => {
    const run = await started({ "dev-ubel-1": { review: { checked: [], findings: [NIT], summary: "Only style nits remain.", verdict: "CHANGES_REQUESTED" } } }),
      done = await run.drive(),
      log = await logDir(run),
      verdicts = await readOr(path.join(log, "verdicts.md"), ""),
      step = await readOr(path.join(log, "02-development", "02_ubel-approved-round1.md"), "");
    assert.equal(textAt(done, "action"), "done");
    assert.match(verdicts, /· Development review, round 1 · UBEL \(claude\) · dev-ubel-1 · \*\*APPROVED\*\* \(reviewer's verdict: REJECTED; 0 open blocking finding\(s\)\) · Only style nits remain\./u);
    assert.match(step, /Verdict: \*\*APPROVED\*\* \(reviewer's verdict: REJECTED/u);
  };

await test("verdicts.md is written by the engine alone: a copy changed between calls is kept and replaced", changedCopy);
await test("when the reviewer's own verdict and the stage's outcome differ, the record says both", reviewerDiffers);
