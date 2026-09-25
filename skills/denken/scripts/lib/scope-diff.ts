// Signs of weakened tests in a change: lines deleted from test files, and skip markers added.
import { NONE, STEP, appended, increment, mapAsync, withEntry } from "./lists.ts";
import type { DiffFacts } from "./types-partc.ts";
import { ROOT } from "./paths.ts";
import { START } from "./text.ts";
import path from "node:path";
import { readTextOr } from "./files.ts";

const SHOWN_MAX = 80,
  TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.\w+$|_test\.\w+$/u,
  SKIP_MARKER = /\.skip\(|\bxit\(|\bxdescribe\(|\bxtest\(|@pytest\.mark\.skip|\bt\.Skip\(|skip:\s*true|\.todo\(/u,
  NEW_FILE = /^\+\+\+ (?:b\/)?/u,
  NO_FACTS: DiffFacts = { deletions: {}, file: "", skips: [] },
  shown = (line: string): string => line.trim().slice(START, SHOWN_MAX),
  // One line of the diff: a file header, a line deleted from a test file, or a line that adds a skip marker.
  step = (facts: DiffFacts, line: string): DiffFacts => {
    if (line.startsWith("+++ ")) {
      return { deletions: facts.deletions, file: line.replace(NEW_FILE, ""), skips: facts.skips };
    }
    if (line.startsWith("--- ") || !facts.file) {
      return facts;
    }
    if (TEST_FILE.test(facts.file) && line.startsWith("-") && line.slice(STEP).trim()) {
      return { deletions: withEntry(facts.deletions, facts.file, increment(facts.deletions[facts.file] ?? NONE)), file: facts.file, skips: facts.skips };
    }
    if (line.startsWith("+") && SKIP_MARKER.test(line)) {
      return { deletions: facts.deletions, file: facts.file, skips: appended(facts.skips, `${facts.file}: ${shown(line.slice(STEP))}`) };
    }
    return facts;
  },
  diffFacts = (diff: string): DiffFacts => {
    let facts = NO_FACTS;
    for (const line of diff.split("\n")) {
      facts = step(facts, line);
    }
    return facts;
  },
  // Skip markers in new test files, which the diff against the stage base does not show.
  untrackedSkips = async (untracked: readonly string[]): Promise<readonly string[]> => {
    const tests = untracked.filter((file) => TEST_FILE.test(file)),
      texts = await mapAsync(tests, async (file) => {
        const text = await readTextOr(path.join(ROOT, file), "");
        return text;
      });
    return tests.flatMap((file, index) =>
      (texts[index] ?? "")
        .split("\n")
        .filter((line) => SKIP_MARKER.test(line))
        .map((line) => `${file}: ${shown(line)}`),
    );
  };

export { diffFacts, SKIP_MARKER, TEST_FILE, untrackedSkips };
