// DENKEN engine tests: the wiki stage, told what changed, and kept to documentation. Shared setup is in helpers.ts.
import type { JsonObject, TestRun } from "./test-types.ts";
import { listAt, parsed, textAt } from "./test-json.ts";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { readOr } from "./test-log.ts";
import { setup } from "./helpers.ts";
import { test } from "node:test";

const callFile = async (run: TestRun, name: string): Promise<string> => {
    const text = await readOr(path.join(run.proj, run.run, "calls", name), "");
    return text;
  },
  // Two docs committed before the run: one mentions src.txt, the file STARK changes; the other does not.
  withDocs = async (): Promise<TestRun> => {
    const run = await setup();
    await mkdir(path.join(run.proj, "docs"));
    await writeFile(path.join(run.proj, "docs", "guide.md"), "# Guide\n\nThe `src.txt` file holds the source.\n");
    await writeFile(path.join(run.proj, "docs", "other.md"), "# Other\n\nUnrelated.\n");
    await run.sh("git", "add", ".");
    await run.sh("git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "docs");
    await run.denken("start", run.run);
    return run;
  },
  toldWhatChanged = async (): Promise<void> => {
    const run = await withDocs(),
      done = await run.drive(),
      serie = await callFile(run, "wiki-serie-1.prompt.md"),
      frieren = await callFile(run, "wiki-frieren-1.prompt.md");
    assert.equal(textAt(done, "action"), "done");
    assert.match(serie, /Files changed in this run: src\.txt\./u);
    assert.match(serie, /Existing docs that mention them: docs\/guide\.md \(src\.txt\)\./u);
    assert.doesNotMatch(serie, /docs\/other\.md/u);
    assert.match(frieren, /Code changed in this run: src\.txt\./u);
    assert.match(frieren, /Docs changed in this stage: docs\.md\./u);
  },
  NON_DOC: JsonObject = { "wiki-serie-1": { editFiles: { "lib/x.js": "export const x = 1;\n" } }, "wiki-serie-2": { removeFiles: ["lib/x.js"] } },
  nonDocGoesBack = async (): Promise<void> => {
    const run = await setup(NON_DOC),
      start = await run.denken("start", run.run),
      done = await run.drive(),
      calls = await run.calls(),
      gaps = parsed(await callFile(run, "wiki-serie-1.gaps.json"));
    assert.equal(textAt(start.json, "action"), "started");
    assert.equal(textAt(done, "action"), "done");
    assert.deepEqual(calls.slice(calls.indexOf("claude wiki-serie-1 rw")), ["claude wiki-serie-1 rw", "claude wiki-serie-2 rw", "codex wiki-frieren-2 ro"]);
    assert.deepEqual(
      listAt(gaps, "findings").map((gap) => textAt(gap, "identity")),
      ["wiki-nondoc-lib/x.js"],
    );
  };

await test("the wiki stage is told what changed in this run and which docs mention it", toldWhatChanged);
await test("a wiki worker that changes a file that is not documentation goes straight back", nonDocGoesBack);
