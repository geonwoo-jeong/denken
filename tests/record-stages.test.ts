// DENKEN engine tests: what a stage records and is told: a blocked recovery item, and the docs a run's changes touch. Shared setup is in helpers.ts.
import type { JsonValue, TestRun } from "./test-types.ts";
import { listAt, textAt } from "./test-json.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { qaItem } from "./test-scenario.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const PASSING = 1,
  FAILING = 2,
  FIRST = 0,
  started = async (run: TestRun): Promise<JsonValue | symbol> => {
    await run.denken("start", run.run);
    const end = await run.drive();
    return end;
  },
  // GENAU's results tick the QA list: a passing check with its evidence, a failing one stays open.
  fixBlocked = async (): Promise<void> => {
    const run = await setup({
        "dev-stark-2": { fixTick: false, report: "## TODO status\n- FIX-001 blocked: needs a product decision on rounding\n" },
        "qa-genau-1": { qa: { items: [qaItem(PASSING), qaItem(FAILING, "FAIL")], result: "FAIL" } },
      }),
      end = await started(run),
      todoQa = await readFile(path.join(run.proj, run.run, "todo-qa.md"), "utf8");
    assert.equal(textAt(end, "reason"), "fix_blocked");
    assert.deepEqual(
      listAt(end, "items").map((item) => textAt(item, "item")),
      ["FIX-001"],
    );
    assert.match(textAt(end, "items", FIRST, "report"), /needs a product decision/u);
    assert.match(todoQa, /- \[x\] QA-001 \(REQ-001\) check one\n {2}Evidence: ok \(verified by: x; qa-genau-1\)\n/u);
    assert.match(todoQa, /- \[ \] QA-002 \(REQ-002\) check two\n(?! {2}Evidence)/u);
  },
  // Docs in the project: one names a changed file by path, one only a generic name, one a file the run deletes.
  writeDocs = async (run: TestRun): Promise<void> => {
    await mkdir(path.join(run.proj, "docs"));
    await writeFile(path.join(run.proj, "docs", "api.md"), "The parser lives in lib/parser.js.\n");
    await writeFile(path.join(run.proj, "docs", "index-notes.md"), "See index for everything.\n");
    await writeFile(path.join(run.proj, "docs", "files.md"), "The a.txt file is required.\n");
    await run.sh("git", "add", ".");
    await run.sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "docs");
  },
  documentedRun = async (): Promise<TestRun> => {
    const run = await setup({ "dev-stark-1": { editFiles: { "lib/index.js": "export {};\n", "lib/parser.js": "export const parse = 1;\n" }, removeFiles: ["a.txt"] } });
    await writeDocs(run);
    return run;
  },
  wikiDocs = async (): Promise<void> => {
    const run = await documentedRun(),
      end = await started(run),
      serie = await readFile(path.join(run.proj, run.run, "calls", "wiki-serie-1.prompt.md"), "utf8");
    assert.equal(textAt(end, "action"), "done");
    assert.match(serie, /docs\/api\.md \(lib\/parser\.js\)/u);
    assert.doesNotMatch(serie, /index-notes\.md/u);
    assert.match(serie, /Must update, because they mention files this run deleted: docs\/files\.md\./u);
  };

await test("a recovery item STARK reports blocked goes to DENKEN", fixBlocked);
await test("the wiki stage matches docs by path, by unique non-generic names only, and flags docs of deleted files", wikiDocs);
