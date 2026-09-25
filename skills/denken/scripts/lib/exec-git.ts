/*
 * Git's own files around a call: its config could make the engine's next git command run a program
 * (fsmonitor, filters), and info/exclude could hide new files from the guard. They are pinned
 * before the call and restored after it, before git runs again; what the call left is captured as
 * evidence, written once every repair is done (evidence.ts).
 *
 * A symlink the call planted (for the file, or for info/) is removed, never written through. A
 * symlink that was there before is the user's own: the file behind it is restored only while the
 * symlink still resolves to the same real file, else it is reported and left alone.
 */
import { FILE_MODE, exists, linkTo, makeDir, readBinaryOr, realPathOr, removePath, writeBinary } from "./files.ts";
import type { Found, Pin } from "./types-work.ts";
import { mapAsync, mapInOrder } from "./lists.ts";
import type { PinnedFile } from "./types-partb.ts";
import { ROOT } from "./paths.ts";
import { captureEvidence } from "./evidence.ts";
import { gitText } from "./git.ts";
import { linkTarget } from "./files-tree.ts";
import path from "node:path";
import { pinFile } from "./pin.ts";

const GIT_FILES: readonly string[] = ["config", "info/exclude"],
  OUTSIDE = /^(?:\.\.\/)+/u,
  NOTHING: Found = { evidence: [], lines: [] },
  folderLink = async (file: string, nested: boolean): Promise<string> => {
    if (!nested) {
      return "";
    }
    const link = await linkTarget(path.dirname(file));
    return link;
  },
  // Where git keeps the file. Git that cannot say (its config unreadable, say) stops the call: an unpinned config is an unguarded one.
  gitPath = async (name: string): Promise<string> => {
    const named = await gitText(["rev-parse", "--git-path", name]);
    if (!named || named.includes("\n")) {
      throw new Error(`git could not name its ${name} file, so the guard cannot pin it and the call does not run; check that .git/config is readable`);
    }
    return path.resolve(ROOT, named);
  },
  pinParts = (pins: readonly Pin[]): Pick<PinnedFile, "content" | "mode" | "present" | "unreadable"> => {
    const [pin] = pins;
    if (!pin) {
      return { content: "", mode: FILE_MODE, present: false, unreadable: "" };
    }
    return { content: pin.content, mode: pin.mode, present: true, unreadable: pin.unreadable };
  },
  pinGitFile = async (name: string): Promise<PinnedFile> => {
    const file = await gitPath(name),
      nested = name.includes("/"),
      folder = await folderLink(file, nested),
      link = await linkTarget(file),
      real = await realPathOr(file),
      parts = pinParts(await pinFile(file));
    return { content: parts.content, folder, link, mode: parts.mode, nested, path: file, present: parts.present, real, unreadable: parts.unreadable };
  },
  pinGitFiles = async (): Promise<readonly PinnedFile[]> => {
    const pinned = await mapAsync(GIT_FILES, pinGitFile);
    return pinned;
  },
  gitRel = (file: string): string => `git/${path.relative(path.resolve(ROOT, ".git"), file).replace(OUTSIDE, "")}`,
  shown = (file: string): string => path.relative(ROOT, file),
  // A path's symlink state as it was: whatever is there removed, the symlink that was there made again.
  relink = async (target: string, was: string): Promise<void> => {
    await removePath(target);
    if (was) {
      await linkTo(was, target);
    }
  },
  // The folder first (info/, never the git dir itself): nothing is restored into a folder the call pointed elsewhere.
  repairFolder = async (pinned: PinnedFile, folder: string): Promise<Found> => {
    const evidence = await captureEvidence(folder, gitRel(folder));
    await relink(folder, pinned.folder);
    if (!pinned.folder) {
      await makeDir(folder);
    }
    return { evidence, lines: [`git folder changed: ${shown(folder)} (restored)`] };
  },
  restoreFolder = async (pinned: PinnedFile): Promise<Found> => {
    const folder = path.dirname(pinned.path);
    if (!pinned.nested || (await linkTarget(folder)) === pinned.folder) {
      return NOTHING;
    }
    return repairFolder(pinned, folder);
  },
  // Behind the user's own symlink: written only while it resolves to the same real file.
  writeBehind = async (pinned: PinnedFile): Promise<string> => {
    const real = await realPathOr(pinned.path);
    if (real !== pinned.real) {
      return `git file changed: ${shown(pinned.path)} (not restored: its symlink now resolves to ${real || "nothing"}, not ${pinned.real})`;
    }
    await writeBinary(real, pinned.content, pinned.mode);
    return `git file changed: ${shown(pinned.path)} (restored)`;
  },
  // The file as it was before the call: its symlink, its content, or no file at all.
  putBack = async (pinned: PinnedFile, now: string): Promise<string> => {
    if (now !== pinned.link) {
      await relink(pinned.path, pinned.link);
    }
    if (pinned.link && pinned.present) {
      const line = await writeBehind(pinned);
      return line;
    }
    if (pinned.present) {
      await writeBinary(pinned.path, pinned.content, pinned.mode);
    } else if (!pinned.link) {
      await removePath(pinned.path);
    }
    return `git file changed: ${shown(pinned.path)} (restored)`;
  },
  // A file that could not be read before the call has nothing to restore from: writing "" would erase it.
  restoreOrReport = async (pinned: PinnedFile, now: string): Promise<string> => {
    if (pinned.unreadable) {
      return `git file changed: ${shown(pinned.path)} (not restored: it could not be read before the call: ${pinned.unreadable})`;
    }
    const line = await putBack(pinned, now);
    return line;
  },
  changedFile = async (pinned: PinnedFile, now: string): Promise<Found> => {
    const evidence = await captureEvidence(pinned.path, gitRel(pinned.path)),
      line = await restoreOrReport(pinned, now);
    return { evidence, lines: [line] };
  },
  restoreFile = async (pinned: PinnedFile): Promise<Found> => {
    const now = await linkTarget(pinned.path),
      present = await exists(pinned.path),
      current = await readBinaryOr(pinned.path, "");
    if (now === pinned.link && present === pinned.present && current === pinned.content) {
      return NOTHING;
    }
    return changedFile(pinned, now);
  },
  restoreGitFile = async (pinned: PinnedFile): Promise<Found> => {
    const folder = await restoreFolder(pinned),
      file = await restoreFile(pinned);
    return { evidence: [...folder.evidence, ...file.evidence], lines: [...folder.lines, ...file.lines] };
  },
  // One file after another: config, then info/exclude.
  restoreGitFiles = async (pinned: readonly PinnedFile[]): Promise<Found> => {
    const each = await mapInOrder(pinned, restoreGitFile);
    return { evidence: each.flatMap((found) => found.evidence), lines: each.flatMap((found) => found.lines) };
  };

export { pinGitFiles, restoreGitFiles };
