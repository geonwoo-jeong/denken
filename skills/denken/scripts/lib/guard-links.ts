/*
 * Symlinks among DENKEN's paths, put back as they were before the call: a symlink a call planted is
 * removed (never followed), and one it removed or re-pointed is made again. A folder of DENKEN's
 * files that became a symlink becomes a folder again, so what is restored into it stays inside; the
 * files that were in it are then restored too (guard.ts). What the call left is kept as evidence.
 */
import type { Evidence, ViolationCheck } from "./types-work.ts";
import { linkTo, makeDir, removePath } from "./files.ts";
import { ROOT } from "./paths.ts";
import { captureEvidence } from "./evidence.ts";
import { linkTarget } from "./files-tree.ts";
import path from "node:path";
import { unique } from "./lists.ts";

// A path put back: the line that reports it, what the call left there, and whether the call planted a symlink where there was none.
interface Repair {
  readonly evidence: readonly Evidence[];
  readonly line: string;
  readonly path: string;
  readonly planted: boolean;
}

const changedLinks = (check: ViolationCheck): readonly string[] =>
    unique([...Object.keys(check.before.links), ...Object.keys(check.after.links)])
      .filter((key) => (check.before.links[key] ?? "") !== (check.after.links[key] ?? ""))
      .toSorted((one, two) => one.length - two.length || one.localeCompare(two)),
  describe = (key: string, was: string, now: string): string => {
    if (!was) {
      return `DENKEN path is now a symlink: ${key} → ${now} (removed)`;
    }
    if (!now) {
      return `DENKEN symlink removed: ${key} (restored)`;
    }
    return `DENKEN symlink changed: ${key} → ${now} (restored)`;
  },
  holdsOwned = (check: ViolationCheck, key: string): boolean => Object.keys(check.before.owned).some((file) => file.startsWith(`${key}/`)),
  evidenceAt = async (check: ViolationCheck, key: string): Promise<readonly Evidence[]> => {
    if (!check.callId) {
      return [];
    }
    const kept = await captureEvidence(path.join(ROOT, key), key);
    return kept;
  },
  // Whatever is at the path goes; the symlink that was there is made again, or the folder that was.
  putBack = async (check: ViolationCheck, key: string, was: string): Promise<void> => {
    const target = path.join(ROOT, key);
    await removePath(target);
    if (was) {
      await makeDir(path.dirname(target));
      await linkTo(was, target);
    } else if (holdsOwned(check, key)) {
      await makeDir(target);
    }
  },
  repairOne = async (check: ViolationCheck, key: string): Promise<Repair> => {
    const was = check.before.links[key] ?? "",
      now = await linkTarget(path.join(ROOT, key)),
      evidence = await evidenceAt(check, key);
    await putBack(check, key, was);
    return { evidence, line: describe(key, was, now), path: key, planted: !was && Boolean(now) };
  },
  // One path at a time, shortest first: a folder is put back before what is in it.
  repairInOrder = async (check: ViolationCheck, keys: readonly string[]): Promise<readonly Repair[]> => {
    const [first, ...rest] = keys;
    if (typeof first !== "string") {
      return [];
    }
    return [await repairOne(check, first), ...(await repairInOrder(check, rest))];
  },
  repairLinks = async (check: ViolationCheck): Promise<readonly Repair[]> => {
    const repaired = await repairInOrder(check, changedLinks(check));
    return repaired;
  };

export { repairLinks };
