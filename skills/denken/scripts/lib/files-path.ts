/*
 * The folders on the way to a path the engine writes, copies, moves or deletes, checked first. Below
 * the project root none of them may be a symlink: a call could plant one to make the engine, which
 * runs outside any sandbox, act outside the project for it. Missing folders are made one at a time,
 * so none is made through a symlink either. Paths outside the project root are left as they are.
 */
import { lstat, mkdir } from "node:fs/promises";
import { ROOT } from "./paths.ts";
import { codeOf } from "./text.ts";
import { hasItems } from "./lists.ts";
import path from "node:path";

// A path the engine refuses to use. Its code lets a reader treat it like any other unusable path.
class UnsafePathError extends Error {
  public readonly code = "EUNSAFE";

  public constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

const START = 0,
  NEXT = 1,
  // The folders from just below the project root down to dir itself; none for a path outside the project.
  foldersTo = (dir: string): readonly string[] => {
    const rel = path.relative(ROOT, dir),
      names = rel.split(path.sep);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return [];
    }
    return names.map((_name, index) => path.join(ROOT, ...names.slice(START, index + NEXT)));
  },
  requireFolder = async (dir: string): Promise<void> => {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new UnsafePathError(`refusing to use ${dir}: it is a symlink or not a folder, and DENKEN never writes through one`);
    }
  },
  // Made, or made at the same moment by another write: either way it must be a real folder.
  makeFolder = async (dir: string): Promise<void> => {
    try {
      await mkdir(dir);
    } catch (error) {
      if (codeOf(error) !== "EEXIST") {
        throw error;
      }
    }
    await requireFolder(dir);
  },
  // One folder: a real folder, or made when it is missing and make is set.
  checkFolder = async (dir: string, make: boolean): Promise<void> => {
    try {
      await requireFolder(dir);
    } catch (error) {
      if (!make || codeOf(error) !== "ENOENT") {
        throw error;
      }
      await makeFolder(dir);
    }
  },
  checkAll = async (dirs: readonly string[], make: boolean): Promise<void> => {
    const [first, ...rest] = dirs;
    if (typeof first === "string") {
      await checkFolder(first, make);
      await checkAll(rest, make);
    }
  },
  // The folder a path goes into: checked below the project root, and made when missing if make is set.
  safeFolder = async (dir: string, make: boolean): Promise<void> => {
    const inside = foldersTo(dir);
    if (hasItems(inside)) {
      await checkAll(inside, make);
    } else if (make) {
      await mkdir(dir, { recursive: true });
    }
  };

export { safeFolder, UnsafePathError };
