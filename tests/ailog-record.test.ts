// DENKEN engine tests: the ai-log record every run leaves. Shared setup is in helpers.ts.
import type { JsonValue, TestRun } from "./test-types.ts";
import { REQUEST, changes, finding } from "./test-scenario.ts";
import { fileExists, readOr } from "./test-log.ts";
import { readdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { setup } from "./helpers.ts";
import { test } from "node:test";
import { textAt } from "./test-json.ts";

const TIME = String.raw`\d{2}:\d{2}:\d{2}`,
  LINK = /→ (?<file>\S+)$/u,
  TIMELINE_STEPS: readonly string[] = [
    "DENKEN** · run created",
    "METHODE (claude)** · started plan round 1",
    "RICHTER** · REJECTED (1 blocking)",
    "STOP** · confirm_todos",
    "USER via DENKEN** · confirmed",
    "RESUME** · development starts",
    "GENAU** · PASSED QA cycle 1",
    "ENGINE** · DONE: every stage approved",
  ],
  // Every submission and verdict exchanged, in order, in the words it was given.
  VERDICTS: readonly string[] = [
    String.raw`^- ${TIME} · Planning, round 1 · METHODE \(claude\) · plan-methode-1 · \*\*READY\*\* · methode wrote .* → 01-planning/01_methode-round1\.md$`,
    String.raw`^- ${TIME} · Planning review, round 1 · RICHTER \(codex\) · plan-richter-1 · \*\*REJECTED\*\* · rejected: scope → 01-planning/02_richter-rejected-round1\.md$`,
    String.raw`^- ${TIME} · Planning, round 2 · METHODE \(claude\) · plan-methode-2 · \*\*READY\*\* · .* → 01-planning/03_methode-round2\.md$`,
    String.raw`^- ${TIME} · Planning review, round 2 · RICHTER \(codex\) · plan-richter-2 · \*\*APPROVED\*\* · richter found nothing to change → 01-planning/04_richter-approved-round2\.md$`,
    String.raw`^- ${TIME} · Confirmation · USER · \*\*CONFIRMED\*\* · Looks good, go ahead\. → 01-planning/05_user-confirmed\.md$`,
    String.raw`^- ${TIME} · Development, round 1 · STARK \(codex\) · dev-stark-1 · \*\*READY\*\* · .* → 02-development/01_stark-round1\.md$`,
    String.raw`^- ${TIME} · Development review, round 1 · UBEL \(claude\) · dev-ubel-1 · \*\*APPROVED\*\* · ubel found nothing to change → 02-development/02_ubel-approved-round1\.md$`,
    String.raw`^- ${TIME} · Independent QA, cycle 1 · GENAU \(claude\) · qa-genau-1 · \*\*PASSED\*\* · every check passed on the running product → 03-qa/qa-1/report\.md$`,
    String.raw`^- ${TIME} · Docs, round 1 · SERIE \(claude\) · wiki-serie-1 · \*\*READY\*\* · .* → 04-wiki/01_serie-round1\.md$`,
    String.raw`^- ${TIME} · Docs review, round 1 · FRIEREN \(codex\) · wiki-frieren-1 · \*\*APPROVED\*\* · frieren found nothing to change → 04-wiki/02_frieren-approved-round1\.md$`,
    String.raw`^- ${TIME} · Done · ENGINE · \*\*DONE\*\* · every stage approved$`,
  ],
  ls = async (log: string, dir: string): Promise<readonly string[]> => {
    const names = await readdir(path.join(log, dir));
    return names.toSorted();
  },
  logFile = async (log: string, file: string): Promise<string> => {
    const text = await readOr(path.join(log, file), "");
    return text;
  },
  linkOf = (line: string): string => {
    const match = LINK.exec(line);
    if (match === null) {
      return "";
    }
    return (match.groups ?? {})["file"] ?? "";
  },
  // A run whose planning is rejected once, with DENKEN's conversation with the user kept beside it.
  started = async (): Promise<TestRun> => {
    const run = await setup({ "plan-richter-1": changes(finding("scope", { file: "todo-dev.md" })) });
    await writeFile(path.join(run.proj, run.run, "conversation.md"), "**User:** Build it.\n**DENKEN:** Which cases?\n**User:** Two.\n");
    await run.denken("start", run.run);
    return run;
  },
  // DENKEN's request.md, as confirmed; the conversation it came from is kept raw.
  checkRequest = async (log: string): Promise<void> => {
    const top = await ls(log, "."),
      request = await logFile(log, path.join("00-request", "request.md")),
      conversation = await logFile(log, path.join("raw", "000_conversation.md"));
    assert.deepEqual(top, ["00-request", "01-planning", "02-development", "03-qa", "04-wiki", "raw", "timeline.md", "verdicts.md"]);
    assert.equal(request, REQUEST);
    assert.match(conversation, /Which cases\?/u);
  },
  checkPlanning = async (log: string): Promise<void> => {
    const planning = await ls(log, "01-planning"),
      rejected = await logFile(log, path.join("01-planning", "02_richter-rejected-round1.md"));
    assert.deepEqual(planning, ["01_methode-round1.md", "02_richter-rejected-round1.md", "03_methode-round2.md", "04_richter-approved-round2.md", "05_user-confirmed.md"]);
    assert.match(rejected, /Verdict: \*\*REJECTED\*\*[\s\S]*\[scope\] todo-dev\.md:1: scope problem\n {3}Required change: fix scope[\s\S]*What was checked/u);
  },
  checkStages = async (log: string): Promise<void> => {
    const development = await ls(log, "02-development"),
      stark = await logFile(log, path.join("02-development", "01_stark-round1.md")),
      qa = await ls(log, path.join("03-qa", "qa-1")),
      evidence = await ls(log, path.join("03-qa", "qa-1", "evidence")),
      report = await logFile(log, path.join("03-qa", "qa-1", "report.md")),
      wiki = await ls(log, "04-wiki");
    assert.deepEqual(development, ["01_stark-round1.md", "02_ubel-approved-round1.md"]);
    assert.match(stark, /- DEV-001: `echo ok` exit 0/u);
    assert.deepEqual(qa, ["evidence", "report.md"]);
    assert.deepEqual(evidence, ["QA-001.txt", "QA-002.txt"]);
    assert.match(report, /\| QA-002 \| REQ-002 \| PASS \|[^\n]*`QA-002\.txt` \|/u);
    assert.deepEqual(wiki, ["01_serie-round1.md", "02_frieren-approved-round1.md"]);
  },
  // Every call's exchange, in order, and every step, verdict, stop and resume in the timeline.
  checkRawAndTimeline = async (log: string, state: JsonValue | symbol): Promise<void> => {
    const raw = await ls(log, "raw"),
      timeline = await logFile(log, "timeline.md");
    assert.ok(raw.includes("001_plan-methode-1.prompt.md"));
    assert.ok(raw.some((name) => /^\d{3}_wiki-frieren-1\.out\.json$/u.test(name)));
    for (const step of TIMELINE_STEPS) {
      assert.ok(timeline.includes(step), `timeline is missing: ${step}`);
    }
    // The finished verdicts.md's digest is in the timeline.
    assert.ok(timeline.includes(`verdicts.md sha256: ${textAt(state, "verdictsSha")}`));
  },
  // Every verdict line in the words it was given, and every file a verdict links to exists.
  checkVerdicts = async (log: string): Promise<void> => {
    const text = await logFile(log, "verdicts.md"),
      verdicts = text.split("\n").filter((line) => line.startsWith("- ")),
      links = verdicts.map((line) => linkOf(line)).filter(Boolean),
      present = await Promise.all(
        links.map(async (file) => {
          const found = await fileExists(path.join(log, file));
          return found;
        }),
      );
    assert.equal(verdicts.length, VERDICTS.length, verdicts.join("\n"));
    for (const [index, pattern] of VERDICTS.entries()) {
      assert.match(verdicts[index] ?? "", new RegExp(pattern, "u"));
    }
    assert.deepEqual(
      links.filter((_file, index) => present[index] !== true),
      [],
    );
  },
  record = async (): Promise<void> => {
    const run = await started(),
      done = await run.drive(),
      state = await run.state(),
      log = path.join(run.proj, textAt(state, "log"));
    assert.equal(textAt(done, "action"), "done");
    assert.match(textAt(state, "log"), /^ai-log\/\d{8}\/001_\d{6}_test-task$/u);
    await checkRequest(log);
    await checkPlanning(log);
    await checkStages(log);
    await checkRawAndTimeline(log, state);
    await checkVerdicts(log);
  };

await test("every run leaves an ai-log record: request, per-step files, QA evidence, raw exchanges and a timeline", record);
