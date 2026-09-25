/*
 * DENKEN's own files after a call: a change is undone and reported, and what the call left is
 * captured as evidence (written later, once every repair is done: evidence.ts). Symlinks are put
 * back first, shortest path first, so nothing is written, copied or removed through a symlink a
 * call planted. Project files are only reported: they belong to the user, who decides what to keep.
 */
import type { Evidence, Found, ViolationCheck } from "./types-work.ts";
import { exists, isFile, readBinaryOr, removePath, writeBinary } from "./files.ts";
import { mapAsync, unique } from "./lists.ts";
import { ROOT } from "./paths.ts";
import type { Tree } from "./types-names.ts";
import { captureEvidence } from "./evidence.ts";
import { ignoredViolations } from "./guard-ignored.ts";
import path from "node:path";
import { repairLinks } from "./guard-links.ts";

type Entry = readonly [string, string];

// One of DENKEN's paths put back: the line that reports it, and what the call left there.
interface Restored {
  readonly evidence: readonly Evidence[];
  readonly line: string;
}

const AGENT_CONTEXT = /(?:^|\/)(?:CLAUDE|CLAUDE\.local|AGENTS)\.md$|^\.(?:claude|codex|agents|cursor|gemini)\/|^\.mcp\.json$/u,
  SYMLINK = "symlink:",
  restoredMark = (restored: boolean): string => {
    if (restored) {
      return " (restored)";
    }
    return "";
  },
  keepTampered = async (check: ViolationCheck, file: string): Promise<readonly Evidence[]> => {
    if (!check.callId) {
      return [];
    }
    const kept = await captureEvidence(path.join(ROOT, file), file);
    return kept;
  },
  // The pinned content written back, in place of whatever is there now (a folder, a FIFO); or a path DENKEN did not have, removed.
  putBack = async (check: ViolationCheck, file: string): Promise<boolean> => {
    const target = path.join(ROOT, file);
    if (Object.hasOwn(check.pinned, file)) {
      if (!(await isFile(target))) {
        await removePath(target);
      }
      await writeBinary(target, check.pinned[file] ?? "");
      return true;
    }
    if (!Object.hasOwn(check.before.owned, file)) {
      await removePath(target);
      return true;
    }
    return false;
  },
  restoreOwned = async (check: ViolationCheck, file: string): Promise<Restored> => {
    const evidence = await keepTampered(check, file),
      restored = await putBack(check, file);
    return { evidence, line: `DENKEN file changed: ${file}${restoredMark(restored)}` };
  },
  restoreInOrder = async (check: ViolationCheck, files: readonly string[]): Promise<readonly Restored[]> => {
    const [first, ...rest] = files;
    if (typeof first !== "string") {
      return [];
    }
    return [await restoreOwned(check, first), ...(await restoreInOrder(check, rest))];
  },
  ancestorsOf = (file: string): readonly string[] => {
    const parent = path.dirname(file);
    if (parent === file || parent === "." || parent === "..") {
      return [];
    }
    return [parent, ...ancestorsOf(parent)];
  },
  // The paths that were symlinks before the call.
  linkedBefore = (check: ViolationCheck): readonly string[] => Object.keys(check.before.links).filter((key) => Boolean(check.before.links[key])),
  // A path that was a symlink before the call, or lay behind one: guard-links.ts put those back.
  wasLinked = (check: ViolationCheck, linked: readonly string[], file: string): boolean =>
    (check.before.owned[file] ?? "").startsWith(SYMLINK) || ancestorsOf(file).some((dir) => linked.includes(dir)),
  // A symlink planted where nothing was: guard-links.ts removed it and said so.
  plantedLink = (check: ViolationCheck, file: string): boolean => !Object.hasOwn(check.before.owned, file) && (check.after.owned[file] ?? "").startsWith(SYMLINK),
  // What changed behind a symlink that is still in place is reported, never written through it.
  linkedLines = (check: ViolationCheck, files: readonly string[]): readonly string[] =>
    files
      .filter((file) => (check.before.owned[file] ?? "").startsWith(SYMLINK) && check.before.links[file] === check.after.links[file])
      .map((file) => `DENKEN file changed behind a symlink: ${file} (not restored)`),
  // DENKEN's files in a folder a call replaced by a symlink: the listing saw only what was behind it, so each is restored.
  underPlanted = (check: ViolationCheck, planted: readonly string[]): readonly string[] =>
    Object.keys(check.before.owned).filter((file) => ancestorsOf(file).some((dir) => planted.includes(dir))),
  changedFiles = (check: ViolationCheck, planted: readonly string[]): readonly string[] => {
    const allowed = new Set(check.guard.allow.map((file) => path.relative(ROOT, path.join(check.runDir, file)))),
      differ = unique([...Object.keys(check.before.owned), ...Object.keys(check.after.owned)]).filter((file) => check.before.owned[file] !== check.after.owned[file]);
    return unique([...differ, ...underPlanted(check, planted)])
      .filter((file) => !allowed.has(file))
      .toSorted((one, two) => one.length - two.length || one.localeCompare(two));
  },
  ownedViolations = async (check: ViolationCheck, planted: readonly string[]): Promise<Found> => {
    const changed = changedFiles(check, planted),
      linked = linkedBefore(check),
      restored = await restoreInOrder(
        check,
        changed.filter((file) => !wasLinked(check, linked, file) && !plantedLink(check, file)),
      );
    return { evidence: restored.flatMap((one) => one.evidence), lines: [...linkedLines(check, changed), ...restored.map((one) => one.line)] };
  },
  projectViolation = (check: ViolationCheck): readonly string[] => {
    if (check.guard.frozen && check.before.project !== check.after.project) {
      return ["project files changed (inspect with git status and git diff)"];
    }
    return [];
  },
  violations = async (check: ViolationCheck): Promise<Found> => {
    const ignored = await ignoredViolations(check),
      links = await repairLinks(check),
      planted = links.filter((repair) => repair.planted).map((repair) => repair.path),
      owned = await ownedViolations(check, planted);
    return {
      evidence: [...links.flatMap((repair) => repair.evidence), ...owned.evidence],
      lines: [...projectViolation(check), ...ignored, ...links.map((repair) => repair.line), ...owned.lines],
    };
  },
  pinEntry = async (file: string): Promise<readonly Entry[]> => {
    const target = path.join(ROOT, file),
      present = await exists(target),
      content = await readBinaryOr(target, "");
    if (present) {
      return [[file, content]];
    }
    return [];
  },
  // The contents of DENKEN's files (latin1), to restore them from; logs and symlinks are left out.
  pinOwned = async (owned: Tree): Promise<Tree> => {
    const entries = await mapAsync(
      Object.keys(owned).filter((file) => !file.endsWith(".log") && !(owned[file] ?? "").startsWith(SYMLINK)),
      pinEntry,
    );
    return Object.fromEntries(entries.flat());
  };

export { AGENT_CONTEXT, pinOwned, violations };
