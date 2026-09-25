// DENKEN engine tests: dev-ticks. Shared setup is in helpers.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changes, FAKE, finding, qaItem, REQUEST, SCRIPTS, setup, TWO_UNITS } from "./helpers.mjs";

test("no tick without evidence that names a file changed for the item", () => {
  // Evidence that names no changed file, or none at all, is refused, so nothing is ticked.
  for (const evidence of ["did the work", ""]) {
    const t = setup({ "dev-stark-1": { evidence } });
    t.denken("start", t.run);
    assert.equal(t.drive().action, "done");
    const gaps = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.gaps.json"), "utf8")).findings;
    assert.deepEqual(gaps.map((g) => g.problem), ["DEV-001 is neither ticked off nor reported blocked in dev-report.md", "DEV-002 is neither ticked off nor reported blocked in dev-report.md"]);
    assert.ok(!existsSync(join(t.proj, t.run, "calls", "dev-stark-1.tick-DEV-001.log")));
  }

  // Names match whole: "a.js" does not name the changed a.jsx.
  const u = setup({ "dev-stark-1": { editFiles: { "a.jsx": "x\n" }, evidence: "changed a.js" } });
  u.denken("start", u.run);
  assert.equal(u.drive().action, "done");
  assert.ok(!existsSync(join(u.proj, u.run, "calls", "dev-stark-1.ticks.jsonl")));

  // A re-tick must name a file changed since the item's last tick: a.txt changed in round 1 only.
  const v = setup({ "dev-stark-1": { editFiles: { "a.txt": "x\n" }, evidence: "changed a.txt and src.txt" }, "dev-ubel-1": changes(finding("x")), "dev-stark-2": { tick: [1], evidence: "changed a.txt" } });
  v.denken("start", v.run);
  assert.equal(v.drive().action, "done");
  assert.ok(existsSync(join(v.proj, v.run, "calls", "dev-stark-1.ticks.jsonl")));
  assert.ok(!existsSync(join(v.proj, v.run, "calls", "dev-stark-2.ticks.jsonl")));
  assert.match(readFileSync(join(v.proj, v.run, "todo-dev.md"), "utf8"), /DEV-001 \(REQ-001\) build one\n {2}Evidence: changed a\.txt and src\.txt\n/);
});

test("tick records are checked again when the call ends: a hand-written record is not applied", () => {
  const t = setup({ "dev-stark-1": { tick: [2], forgeTicks: [{ item: "DEV-001", evidence: "changed a.txt" }, { item: "DEV-009", evidence: "changed src.txt" }] } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const gaps = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.gaps.json"), "utf8")).findings;
  assert.deepEqual(gaps.map((g) => g.problem), ["DEV-001's recorded tick was not accepted: its evidence names no file changed for it since development began"]);
  const timeline = readFileSync(join(t.proj, t.state().log, "timeline.md"), "utf8");
  assert.match(timeline, /tick record\(s\) not accepted: DEV-001 \(its evidence names no file[^)]*\); DEV-009 \(it is not in the TODO section of todo-dev\.md\)/);
  // The base of an applied tick comes from the engine, not from the record.
  const base = t.state().tickBases["DEV-001"];
  assert.equal(base.call, "dev-stark-2");
  assert.deepEqual(Object.keys(base.tree), ["src.txt"]);
});

test("an item that needs no change is ticked with its reason, which UBEL judges", () => {
  const t = setup({ "dev-stark-1": { noChange: { 2: "DEV-001's change already covers it" } } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.match(readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8"), /DEV-002 \(REQ-002\) build two\n {2}Evidence: No change needed: DEV-001's change already covers it\n/);
  assert.match(readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.prompt.md"), "utf8"), /Items ticked as needing no change: DEV-002 \(No change needed: DEV-001's change already covers it\)/);
});

test("a recovery item that reverts a file can name it: evidence is measured from the QA cycle", () => {
  const t = setup({
    "dev-stark-1": { editFiles: { "a.txt": "broken\n" }, evidence: "changed a.txt and src.txt" },
    "qa-genau-1": { qa: { result: "FAIL", items: [qaItem(1), qaItem(2, "FAIL")] } },
    "dev-stark-2": { editFiles: { "a.txt": "a\n" }, fixEvidence: "reverted a.txt to its original content" },
  });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.match(readFileSync(join(t.proj, t.run, "todo-fix.md"), "utf8"), /- \[x\] FIX-001 [^\n]*\n {2}Evidence: reverted a\.txt to its original content\n/);
});

test("only METHODE words the TODO: STARK rewording an item is undone", () => {
  const t = setup({ "dev-stark-1": { editTodo: [["build one", "build one, and a bit more"]] } });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.reason, "guard_violation");
  assert.match(r.violations.join("\n"), /todo-dev\.md/);
  assert.doesNotMatch(readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8"), /a bit more/);
});

test("a DEV item neither ticked off nor reported blocked goes straight back to STARK", () => {
  const t = setup({ "dev-stark-1": { tick: [1] } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const calls = t.calls();
  assert.deepEqual(calls.slice(calls.indexOf("codex dev-stark-1 rw"), calls.indexOf("codex dev-stark-1 rw") + 3), ["codex dev-stark-1 rw", "codex dev-stark-2 rw", "claude dev-ubel-2 ro"]);
  const gaps = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.gaps.json"), "utf8"));
  assert.deepEqual(gaps.findings.map((f) => f.identity), ["DEV-002"]);
});

test("a DEV item reported blocked goes to UBEL, who sees each item's status and the change scope", () => {
  const todoDev = "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) build one. Files: `lib/one.js`, `test/one.test.js`.\n- [ ] DEV-002 (REQ-002) build two. Files: `src.txt`.\n  - sub-note naming `lib/extra.js`\n\n## Open questions\n- None\n";
  const t = setup({ "plan-methode-1": { todoDev }, "dev-stark-1": { tick: [1], report: "## TODO status\n- DEV-001 done\n- DEV-002 blocked: needs a design decision\n" } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.ok(t.calls().includes("claude dev-ubel-1 ro"));
  const prompt = readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.prompt.md"), "utf8");
  assert.match(prompt, /Items, evidence and recorded test runs: DEV-001 \[x\], evidence: "changed src\.txt", test `echo ok` exit 0 \(ok\), DEV-002 \[ \] reported blocked/);
  assert.match(prompt, /Files changed in this stage: src\.txt/);
  assert.match(prompt, /Changed files that no DEV item names: none/);
  assert.match(prompt, /Ticked DEV items none of whose named files changed: DEV-001 \(lib\/one\.js, test\/one\.test\.js\)/);
  assert.match(prompt, /Ticked DEV items with no named test file added or changed: DEV-001\./);
});

test("UBEL is told about changed files that no DEV item names", () => {
  const t = setup();
  t.denken("start", t.run);
  t.drive();
  assert.match(readFileSync(join(t.proj, t.run, "calls", "dev-ubel-1.prompt.md"), "utf8"), /Changed files that no DEV item names: src\.txt\./);
});

test("an item whose test run fails stays unticked and goes back to STARK", () => {
  const t = setup({ "dev-stark-1": { tickFail: [2] } });
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const gaps = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.gaps.json"), "utf8")).findings;
  assert.deepEqual(gaps.map((g) => [g.identity, g.problem]), [["DEV-002", "DEV-002 is neither ticked off nor reported blocked in dev-report.md"]]);
  assert.match(readFileSync(join(t.proj, t.run, "calls", "dev-stark-1.tick-DEV-002.log"), "utf8"), /\[exit 1\]/);
  assert.ok(!t.calls().includes("claude dev-ubel-1 ro"));
});

test("the engine is the only writer of ticks and evidence: any edit STARK makes to a TODO file is undone", () => {
  const t = setup({ "dev-ubel-1": changes(finding("x")), "dev-stark-2": { untickByHand: [1], tick: [] } });
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.reason, "guard_violation");
  assert.equal(r.call, "dev-stark-2");
  assert.match(readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8"), /- \[x\] DEV-001/);

  // A tick by hand, even of a real item, and an evidence line rewritten by hand.
  for (const scenario of [{ "dev-stark-1": { tickByHand: [1], tick: [] } }, { "dev-ubel-1": changes(finding("x")), "dev-stark-2": { editTodo: [["Evidence: changed src.txt", "Evidence: rewrote the whole of src.txt"]], tick: [] } }]) {
    const h = setup(scenario);
    h.denken("start", h.run);
    assert.equal(h.drive().reason, "guard_violation");
    assert.doesNotMatch(readFileSync(join(h.proj, h.run, "todo-dev.md"), "utf8"), /rewrote/);
  }

  const todoDev = "## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) one\n- [ ] DEV-002 (REQ-002) two\n- [ ] note: keep it small\n\n## Open questions\n- None\n";
  const u = setup({ "plan-methode-1": { todoDev }, "dev-stark-1": { tickOther: "note" } });
  u.denken("start", u.run);
  assert.equal(u.drive().reason, "guard_violation");
});

test("after a QA failure the engine unticks the DEV items for the failing request item", () => {
  const t = setup({ "qa-genau-1": { qa: { result: "FAIL", items: [qaItem(1), qaItem(2, "FAIL")] } }, "dev-stark-2": { tick: [] } });
  t.denken("start", t.run);
  t.drive();
  // DEV-002 serves REQ-002 and was unticked; STARK's second round did not re-tick it with a test run.
  const gaps = JSON.parse(readFileSync(join(t.proj, t.run, "calls", "dev-stark-2.gaps.json"), "utf8")).findings;
  assert.deepEqual(gaps.map((g) => g.identity), ["DEV-002"]);
  assert.equal(t.state().unticked["DEV-002"].cycle, 1);
  assert.ok(!t.state().unticked["DEV-001"]);
});

test("the tick command refuses outside a development call", () => {
  const t = setup();
  t.denken("start", t.run);
  const r = t.denken("tick", t.run, "DEV-001", "--", "true");
  assert.equal(r.status, 1);
  assert.match(r.json.error, /only for STARK|for STARK, during a development call/);
});
