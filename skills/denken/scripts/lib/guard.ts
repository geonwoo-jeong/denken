/*
 * DENKEN's own files after a call: a change is undone and reported, and what the call left is
 * captured as evidence (written later, once every repair is done: evidence.ts). Symlinks are put
 * back first, shortest path first, so nothing is written, copied or removed through a symlink a
 * call planted. Project files are only reported: they belong to the user, who decides what to keep.
 */
import type { Evidence, Found, Pin, ViolationCheck } from "./types-work.ts";
import { SYMLINK, UNREADABLE_FOLDER } from "./guard-snapshot.ts";
import { entriesOf, unique } from "./lists.ts";
import { isFile, removePath, writeBinary } from "./files.ts";
import { ROOT } from "./paths.ts";
import { captureEvidence } from "./evidence.ts";
import { ignoredViolations } from "./guard-ignored.ts";
import path from "node:path";
import { repairLinks } from "./guard-links.ts";

// One of DENKEN's paths put back: the line that reports it, and what the call left there.
interface Restored {
  readonly evidence: readonly Evidence[];
  readonly line: string;
}

const AGENT_CONTEXT = /(?:^|\/)(?:CLAUDE|CLAUDE\.local|AGENTS)\.md$|^\.(?:claude|codex|agents|cursor|gemini)\/|^\.mcp\.json$/u,
  keepTampered = async (check: ViolationCheck, file: string): Promise<readonly Evidence[]> => {
    if (!check.callId) {
      return [];
    }
    const kept = await captureEvidence(path.join(ROOT, file), file);
    return kept;
  },
  ancestorsOf = (file: string): readonly string[] => {
    const parent = path.dirname(file);
    if (parent === file || parent === "." || parent === "..") {
      return [];
    }
    return [parent, ...ancestorsOf(parent)];
  },
  pinOf = (check: ViolationCheck, file: string): readonly Pin[] =>
    entriesOf(check.pinned)
      .filter(([name]) => name === file)
      .map(([, pin]) => pin),
  // The pinned content and permission bits written back, in place of whatever is there now (a folder, a FIFO).
  restorePin = async (target: string, pin: Pin): Promise<string> => {
    if (pin.unreadable) {
      return ` (not restored: it could not be read before the call: ${pin.unreadable})`;
    }
    if (!(await isFile(target))) {
      await removePath(target);
    }
    await writeBinary(target, pin.content, pin.mode);
    return " (restored)";
  },
  /*
   * A pinned file is written back; a path DENKEN did not have is removed, unless its folder could
   * not be read before the call: what was in it then is unknown, so nothing there is removed.
   */
  putBack = async (check: ViolationCheck, file: string, blind: readonly string[]): Promise<string> => {
    const target = path.join(ROOT, file),
      [pin] = pinOf(check, file);
    if (pin) {
      const mark = await restorePin(target, pin);
      return mark;
    }
    if (Object.hasOwn(check.before.owned, file)) {
      return "";
    }
    if (ancestorsOf(file).some((dir) => blind.includes(dir))) {
      return " (left as it is: its folder could not be read before the call)";
    }
    await removePath(target);
    return " (restored)";
  },
  restoreOwned = async (check: ViolationCheck, file: string, blind: readonly string[]): Promise<Restored> => {
    const evidence = await keepTampered(check, file),
      mark = await putBack(check, file, blind);
    return { evidence, line: `DENKEN file changed: ${file}${mark}` };
  },
  restoreInOrder = async (check: ViolationCheck, files: readonly string[], blind: readonly string[]): Promise<readonly Restored[]> => {
    const [first, ...rest] = files;
    if (typeof first !== "string") {
      return [];
    }
    return [await restoreOwned(check, first, blind), ...(await restoreInOrder(check, rest, blind))];
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
  /*
   * A folder that could not be read, before the call or after it: reported, never restored or
   * removed, and nothing is restored into one the call made unreadable.
   */
  unreadableFolder = (check: ViolationCheck, file: string): boolean => check.before.owned[file] === UNREADABLE_FOLDER || check.after.owned[file] === UNREADABLE_FOLDER,
  folderLines = (check: ViolationCheck, files: readonly string[]): readonly string[] =>
    files.filter((file) => unreadableFolder(check, file)).map((file) => `DENKEN folder could not be read before or after the call: ${file} (its permissions changed; not restored)`),
  ownedViolations = async (check: ViolationCheck, planted: readonly string[]): Promise<Found> => {
    const changed = changedFiles(check, planted),
      linked = linkedBefore(check),
      blind = Object.keys(check.before.owned).filter((file) => check.before.owned[file] === UNREADABLE_FOLDER),
      hidden = new Set(Object.keys(check.after.owned).filter((file) => check.after.owned[file] === UNREADABLE_FOLDER)),
      restored = await restoreInOrder(
        check,
        changed.filter((file) => !wasLinked(check, linked, file) && !plantedLink(check, file) && !unreadableFolder(check, file) && !ancestorsOf(file).some((dir) => hidden.has(dir))),
        blind,
      );
    return { evidence: restored.flatMap((one) => one.evidence), lines: [...linkedLines(check, changed), ...folderLines(check, changed), ...restored.map((one) => one.line)] };
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
  };

export { AGENT_CONTEXT, violations };
