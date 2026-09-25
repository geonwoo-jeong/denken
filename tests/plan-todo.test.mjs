// DENKEN engine tests: plan-todo. Shared setup is in helpers.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changes, FAKE, finding, qaItem, REQUEST, SCRIPTS, setup, TWO_UNITS } from "./helpers.mjs";

test("development waits until the user confirms the TODO lists; a change request replans", () => {
  const t = setup();
  t.denken("start", t.run);
  const gate = t.drive({ autoConfirm: false });
  assert.equal(gate.action, "needs_user");
  assert.equal(gate.reason, "confirm_todos");
  assert.deepEqual(gate.files.map((f) => f.split("/").pop()), ["request.md", "todo-dev.md", "todo-qa.md"]);
  assert.ok(!t.calls().some((c) => c.includes("dev-stark")));
  assert.equal(t.denken("retry", t.run).status, 1);
  assert.equal(t.denken("rule", t.run, "--decision", "uphold", "--note", "x").status, 1);

  assert.equal(t.denken("rule", t.run, "--decision", "replan", "--note", "The user wants DEV-002 split in two.").json.action, "ruled");
  assert.equal(t.drive({ autoConfirm: false }).reason, "confirm_todos");
  assert.ok(t.calls().includes("claude plan-methode-2 rw"));
  assert.match(readFileSync(join(t.proj, t.run, "calls", "plan-methode-2.prompt.md"), "utf8"), /rulings\.md/);
  assert.equal(t.denken("confirm", t.run).status, 1);
  assert.equal(t.denken("confirm", t.run, "--user-said", "Yes, build it.").json.action, "confirmed");
  assert.equal(t.state().confirmed.userSaid, "Yes, build it.");
  assert.equal(t.drive().action, "done");
});

test("each role reads only its inputs: STARK the dev TODO, GENAU the request and QA TODO, reviewers the request", () => {
  const t = setup();
  t.denken("start", t.run);
  t.drive();
  const reads = (call) => {
    const prompt = readFileSync(join(t.proj, t.run, "calls", `${call}.prompt.md`), "utf8");
    return prompt.match(/- Read:\n((?: {2}- .+\n)+)/)[1].split("\n").filter(Boolean).map((l) => l.split("/").pop());
  };
  assert.deepEqual(reads("plan-methode-1"), ["request.md"]);
  assert.deepEqual(reads("plan-richter-1"), ["request.md", "todo-dev.md", "todo-qa.md"]);
  assert.deepEqual(reads("dev-stark-1"), ["todo-dev.md"]);
  assert.deepEqual(reads("dev-ubel-1"), ["request.md", "todo-dev.md", "dev-report.md", "dev-ubel-1.diff"]);
  assert.deepEqual(reads("qa-genau-1"), ["request.md", "todo-qa.md"]);
  assert.ok(reads("wiki-frieren-1").includes("request.md"));
  // Each stage has its own reviewer, whose instructions add the rules every reviewer shares. The
  // instructions are the call's system part, the same for every call of the role, so a provider
  // can cache them; the call's own facts are the message.
  for (const [call, name] of [["plan-richter-1", "RICHTER"], ["dev-ubel-1", "UBEL"], ["wiki-frieren-1", "FRIEREN"]]) {
    const system = readFileSync(join(t.proj, t.run, "calls", `${call}.system.md`), "utf8");
    assert.ok(system.startsWith(`# ${name}:`));
    assert.match(system, /## How every DENKEN reviewer works/);
    assert.ok(readFileSync(join(t.proj, t.run, "calls", `${call}.prompt.md`), "utf8").startsWith("## This call"));
  }
  const claudeArgs = t.argsOf("dev-ubel-1");
  assert.equal(claudeArgs[claudeArgs.indexOf("--append-system-prompt-file") + 1], join(realpathSync(t.proj), t.run, "calls", "dev-ubel-1.system.md"));
  // Per-machine sections move out of the system prompt only in units' worktrees, where it helps.
  assert.ok(!claudeArgs.includes("--exclude-dynamic-system-prompt-sections"));
});

test("TODO lists with coverage gaps go straight back to METHODE, each gap with its own identity", () => {
  const todoDev = "## Acceptance\n- REQ-001. One. Done when: one works!\n\n## TODO\n- [ ] DEV-001 (REQ-001) one\n- [ ] DEV-002 (OUT-001) three\n- DEV-003 (REQ-001) no checkbox\n";
  const todoQa = "## Checks\n- [ ] QA-001 (REQ-001) one\n\n## Notes\n- QA-001 already covers REQ-001; this prose line is not an item.\n";
  const t = setup({ "plan-methode-1": { todoDev, todoQa } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  // No review was spent on the gapped lists.
  assert.deepEqual(t.calls().slice(0, 3), ["claude plan-methode-1 rw", "claude plan-methode-2 rw", "codex plan-richter-2 ro"]);
  const gaps = t.state().findings.plan.filter((f) => f.source === "engine");
  assert.deepEqual([...new Set(gaps.map((g) => g.identity))].sort(), ["DEV-002", "REQ-002", "todo-copy-CAUTION-001", "todo-copy-LATER-001", "todo-copy-OUT-001", "todo-copy-REQ-001", "todo-copy-REQ-002", "todo-format-DEV-003"].sort());
  assert.ok(gaps.some((g) => g.problem === "DEV-002 builds OUT-001, which the request puts out of scope"));
  assert.ok(gaps.some((g) => g.problem === "REQ-001 in the Acceptance section of todo-dev.md differs from request.md"));
  assert.ok(!gaps.some((g) => /QA-001/.test(g.problem)));
  assert.match(readFileSync(join(t.proj, t.run, "calls", "plan-methode-2.prompt.md"), "utf8"), /plan-methode-1\.gaps\.json/);
});

test("a QA item may check a caution, and a DEV item may name the cautions it keeps", () => {
  const todoDev = "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001, CAUTION-001) one\n- [ ] DEV-002 (REQ-002) two\n\n## Open questions\n- None\n";
  const todoQa = "## Checks\n- [ ] QA-001 (REQ-001) one\n- [ ] QA-002 (REQ-002) two\n- [ ] QA-003 (CAUTION-001) the change stays small\n";
  const t = setup({ "plan-methode-1": { todoDev, todoQa } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.ok(!t.calls().includes("claude plan-methode-2 rw"));
});

test("a QA item missing from the QA report counts as a failure", () => {
  const t = setup({ "qa-genau-1": { qa: { result: "PASS", items: [qaItem(1)] } } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.ok(t.calls().includes("codex dev-stark-2 rw"));
  assert.match(readFileSync(join(t.proj, t.run, "todo-fix.md"), "utf8"), /FIX-001 \(QA-002, REQ-002\) Fix: check two\. Observed: missing from the QA report\./);
});

test("STARK may not edit the TODO lists or the request", () => {
  const t = setup({ "dev-stark-1": { touch: "$RUN/todo-dev.md" } });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.reason, "guard_violation");
  assert.match(r.violations.join("\n"), /todo-dev\.md \(restored\)/);
  assert.doesNotMatch(readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8"), /tampered/);
});

test("start refuses open clarification markers and REQ items without Done when", () => {
  const t = setup();
  writeFileSync(join(t.proj, t.run, "request.md"), "## Goal\nX.\n\n## Confirmed\n- REQ-001. One. Done when: it works.\n- REQ-002. Two.\n\n## Out of scope\n- None\n\n## Not now\n- None\n\n## Cautions\n- None\n\n[NEEDS CLARIFICATION: which encoding?]\n");
  const r = t.denken("start", t.run);
  assert.equal(r.status, 1);
  assert.match(r.json.error, /REQ-002 needs a "Done when:"/);
  assert.match(r.json.error, /which encoding\?/);
});

test("open questions in the development TODO must be answered before development starts", () => {
  const withQuestion = "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) one\n- [ ] DEV-002 (REQ-002) two\n\n## Open questions\n- Should errors be logged?\n";
  const t = setup({ "plan-methode-1": { todoDev: withQuestion } });
  t.denken("start", t.run);
  const gate = t.drive({ autoConfirm: false });
  assert.deepEqual(gate.openQuestions, ["Should errors be logged?"]);
  const refused = t.denken("confirm", t.run, "--user-said", "ok");
  assert.equal(refused.status, 1);
  assert.match(refused.json.error, /open questions/);
  writeFileSync(join(t.proj, t.run, "request.md"), `${readFileSync(join(t.proj, t.run, "request.md"), "utf8")}\n## Decisions\n- Should errors be logged? → No.\n`);
  t.denken("rule", t.run, "--decision", "replan", "--note", "The user answered: errors are not logged.");
  assert.deepEqual(t.drive({ autoConfirm: false }).openQuestions, []);
  assert.equal(t.denken("confirm", t.run, "--user-said", "ok").json.action, "confirmed");
  assert.equal(t.drive().action, "done");
});

test("a change after confirmation stops the run; request or dev TODO changes need a replan", () => {
  const t = setup();
  t.denken("start", t.run);
  t.drive({ autoConfirm: false });
  t.denken("confirm", t.run, "--user-said", "Approved.");
  const request = join(t.proj, t.run, "request.md");
  const original = readFileSync(request, "utf8");
  writeFileSync(request, original.replace("- OUT-001. Three.", "- OUT-001. Three.\n- OUT-002. Four."));
  const r = t.drive({ autoConfirm: false });
  assert.equal(r.reason, "scope_changed");
  assert.deepEqual(r.changed, ["request"]);
  assert.ok(!t.calls().some((c) => c.includes("dev-stark")));
  assert.match(t.denken("confirm", t.run, "--user-said", "Fine.").json.error, /no reviewer has checked the new content/);
  // Restoring what the user approved lets the run continue.
  writeFileSync(request, original);
  assert.equal(t.denken("confirm", t.run, "--user-said", "Approved again.").json.action, "confirmed");
  // A change to the QA TODO alone can be approved directly.
  const qa = join(t.proj, t.run, "todo-qa.md");
  writeFileSync(qa, readFileSync(qa, "utf8").replace("check two", "check two, more carefully"));
  assert.deepEqual(t.drive({ autoConfirm: false }).changed, ["todoQa"]);
  assert.equal(t.denken("confirm", t.run, "--user-said", "OK, the QA change is fine.").json.action, "confirmed");
  assert.equal(t.drive().action, "done");
  assert.equal(t.state().confirmations.length, 3);
});

test("a QA report with items that are not in todo-qa.md is rejected and retried", () => {
  const t = setup({ "qa-genau-1": [{ qa: { result: "FAIL", items: [qaItem(1), qaItem(2), qaItem(99, "FAIL")] } }, {}] });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.equal(t.calls().filter((c) => c.includes("qa-genau-1")).length, 2);
  assert.ok(!t.calls().includes("codex dev-stark-2 rw"));
});

test("after a QA failure, the dev reviewer checks that the fix is general", () => {
  const t = setup({ "qa-genau-1": { qa: { result: "FAIL", items: [qaItem(1), qaItem(2, "FAIL")] } } });
  t.denken("start", t.run);
  t.drive();
  const prompt = readFileSync(join(t.proj, t.run, "calls", "dev-ubel-2.prompt.md"), "utf8");
  assert.match(prompt, /todo-fix\.md/);
  assert.match(prompt, /special-casing/);
  assert.match(prompt, /FIX-001 \[x\], evidence: "fixed the cause in src\.txt", test `echo fixed` exit 0/);
});

test("STARK ticks DEV items off in todo-dev.md, each with its evidence, and may change nothing else there", () => {
  const t = setup();
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const todo = readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8");
  assert.match(todo, /- \[x\] DEV-001 \(REQ-001\) build one\n {2}Evidence: changed src\.txt\n/);
  assert.match(todo, /- \[x\] DEV-002 \(REQ-002\) build two\n {2}Evidence: changed src\.txt\n/);
  // Ticking is not a change to what the user confirmed.
  assert.ok(!t.calls().some((c) => c.includes("dev-stark-2")));
  // The step file shows the list as ticked, with the evidence.
  assert.match(readFileSync(join(t.proj, t.state().log, "02-development", "01_stark-round1.md"), "utf8"), /- \[x\] DEV-001 \(REQ-001\) build one\n {2}Evidence: changed src\.txt/);
});
