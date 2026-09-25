// DENKEN engine tests: units-b. Shared setup is in helpers.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changes, FAKE, finding, qaItem, REQUEST, SCRIPTS, setup, TWO_UNITS } from "./helpers.mjs";

test("units: limits.parallelUnits caps how many units work at once", () => {
  const t = setup({}, { limits: { parallelUnits: 1 } });
  t.split(TWO_UNITS);
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  const calls = t.calls();
  assert.ok(calls.indexOf("claude UNIT-2:plan-methode-1 rw") > calls.indexOf("codex UNIT-1:plan-richter-1 ro"));
  assert.ok(calls.indexOf("codex UNIT-2:dev-stark-1 rw") > calls.indexOf("claude UNIT-1:qa-genau-1 rw"));
});

test("units: a change to the project while units work stops the run until the user says so", () => {
  const t = setup({ "UNIT-1:dev-stark-1": { touch: "$PROJ/a.txt" } });
  t.split(TWO_UNITS);
  t.denken("start", t.run);
  const r = t.drive();
  assert.equal(r.reason, "main_tree_changed");
  assert.deepEqual(r.status, ["M a.txt"]);
  assert.equal(t.denken("retry", t.run).json.action, "resumed");
  assert.equal(t.drive().action, "done");
  assert.equal(readFileSync(join(t.proj, "a.txt"), "utf8"), "a\ntampered\n");
});

test("units: a failure found after the merge is fixed in the project, reviewed and verified again", () => {
  const t = setup({ "qa-genau-1": { qa: { result: "FAIL", summary: "UNIT-1's check fails once merged.", items: [
    { id: "QA-001", request_item: "REQ-001", check: "suite", how_verified: "npm test", result: "PASS", evidence: "ok", reproduce: null },
    { id: "QA-101", request_item: "REQ-001", check: "one", how_verified: "x", result: "FAIL", evidence: "boom", reproduce: "npm test" },
    { id: "QA-201", request_item: "REQ-002", check: "two", how_verified: "x", result: "PASS", evidence: "ok", reproduce: null },
  ] } } });
  t.split(TWO_UNITS);
  t.denken("start", t.run);
  assert.equal(t.drive().action, "done");
  assert.deepEqual(t.calls().slice(-7), ["claude dev-ubel-1 ro", "claude qa-genau-1 rw", "codex dev-stark-2 rw", "claude dev-ubel-2 ro", "claude qa-genau-2 rw", "claude wiki-serie-1 rw", "codex wiki-frieren-1 ro"]);
  assert.match(readFileSync(join(t.proj, t.run, "todo-fix.md"), "utf8"), /- \[x\] FIX-001 \(QA-101, REQ-001\) Fix: one/);
  assert.match(readFileSync(join(t.proj, t.run, "todo-dev.md"), "utf8"), /- \[x\] DEV-101 \(REQ-001\)[^\n]*\n {2}Evidence: changed src\.txt/);
});
