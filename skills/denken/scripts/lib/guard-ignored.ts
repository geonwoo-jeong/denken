/*
 * Ignored files a call may not change. QA runs tests, which often rewrite ignored reports
 * (coverage.xml and the like), so QA is held only to env files. Reviewers and the planner run
 * nothing and are held to all of them.
 */
import { entriesOf, mapAsync } from "./lists.ts";
import type { Guard } from "./types-call.ts";
import { ROOT } from "./paths.ts";
import type { ViolationCheck } from "./types-work.ts";
import { hashFile } from "./files.ts";
import path from "node:path";

type Entry = readonly [string, string];

const ENV_FILE = /(?:^|\/)\.env/u,
  watched = (guard: Guard, file: string): boolean => {
    if (guard.ignored === "all") {
      return true;
    }
    return guard.ignored === "env" && ENV_FILE.test(file);
  },
  ignoredChange = async ([file, hash]: Entry): Promise<readonly string[]> => {
    const current = await hashFile(path.join(ROOT, file));
    if (current === hash) {
      return [];
    }
    return [`ignored file changed: ${file}`];
  },
  ignoredViolations = async (check: ViolationCheck): Promise<readonly string[]> => {
    const changes = await mapAsync(
      entriesOf(check.before.ignored).filter(([file]) => watched(check.guard, file)),
      ignoredChange,
    );
    return changes.flat();
  };

export { ignoredViolations };
