/*
 * Files, text and "binary" text (latin1). Bulk reads take a slot (fs-slot.ts). A path that cannot be
 * used (missing, a symlink loop, no permission, not a regular file) reads as the caller's fallback;
 * running out of resources is thrown. Reads open without blocking and check the open handle, so a
 * FIFO or a device never hangs one. Writes never go through a symlink or hard link a call planted:
 * a file is written whole beside the path and renamed over it, with the permission bits the caller
 * gives, and the folders on the way are checked (files-path.ts). Appends neither follow a symlink,
 * nor block, nor write to a hard link.
 */
import { UnsafePathError, safeFolder } from "./files-path.ts";
import { access, copyFile, lstat, open, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isPathError, pathErrorOr, slotted } from "./fs-slot.ts";
import { codeOf } from "./text.ts";
import { constants } from "node:fs";
import path from "node:path";

type Encoding = "latin1" | "utf8";

// What a write puts in place: the text, how it is encoded, and the file's permission bits.
interface Content {
  readonly encoding: Encoding;
  readonly mode: number;
  readonly text: string;
}

const MISSING = "missing",
  ABSENT: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]),
  ONE_LINK = 1,
  // A new file's permission bits, before the umask: 0644 with the usual umask.
  FILE_MODE = 0o666,
  // Permission bits are the low twelve bits of a mode.
  MODE_SPAN = 4096,
  // The open flags are single bits, so their sum is the set of all of them.
  READ_FLAGS = constants.O_RDONLY + constants.O_NONBLOCK,
  APPEND_FLAGS = constants.O_WRONLY + constants.O_APPEND + constants.O_CREAT + constants.O_NOFOLLOW + constants.O_NONBLOCK,
  exists = slotted(async (target: string): Promise<boolean> => {
    try {
      await access(target);
      return true;
    } catch (error) {
      return pathErrorOr(error, false);
    }
  }),
  // A regular file's content, through a symlink if need be; anything else is refused.
  readRegular = async (file: string, encoding: Encoding): Promise<string> => {
    const handle = await open(file, READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new UnsafePathError(`${file} is not a regular file`);
      }
      return await handle.readFile(encoding);
    } finally {
      await handle.close();
    }
  },
  readText = slotted(async (file: string): Promise<string> => {
    const text = await readRegular(file, "utf8");
    return text;
  }),
  // The engine's own file: empty when it is not there; any other failure is thrown, never read as empty.
  readTextIfThere = slotted(async (file: string): Promise<string> => {
    try {
      return await readRegular(file, "utf8");
    } catch (error) {
      if (ABSENT.has(codeOf(error))) {
        return "";
      }
      throw error;
    }
  }),
  readTextOr = slotted(async (file: string, fallback: string): Promise<string> => {
    try {
      return await readRegular(file, "utf8");
    } catch (error) {
      return pathErrorOr(error, fallback);
    }
  }),
  readBinary = slotted(async (file: string): Promise<string> => {
    const text = await readRegular(file, "latin1");
    return text;
  }),
  readBinaryOr = slotted(async (file: string, fallback: string): Promise<string> => {
    try {
      return await readRegular(file, "latin1");
    } catch (error) {
      return pathErrorOr(error, fallback);
    }
  }),
  hashRegular = async (file: string): Promise<string> => {
    const handle = await open(file, READ_FLAGS);
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        return MISSING;
      }
      return createHash("sha256")
        .update(await handle.readFile())
        .digest("hex");
    } finally {
      await handle.close();
    }
  },
  /*
   * A path that is not there hashes as missing; one that cannot be read, as unreadable with its size
   * and time, so it counts as a change (not an absence) and a later change to it still shows.
   */
  hashFailure = async (file: string, failure: unknown): Promise<string> => {
    const code = codeOf(failure);
    if (ABSENT.has(code)) {
      return MISSING;
    }
    if (!isPathError(failure)) {
      throw failure;
    }
    try {
      const info = await lstat(file);
      return `unreadable:${code}:${info.size}:${info.mtimeMs}`;
    } catch (error) {
      return pathErrorOr(error, `unreadable:${code}`);
    }
  },
  // Only a regular file is read: a FIFO or a device behind a symlink would never end.
  hashFile = slotted(async (file: string): Promise<string> => {
    try {
      return await hashRegular(file);
    } catch (error) {
      return hashFailure(file, error);
    }
  }),
  // The names in a folder; a missing folder has none.
  listNames = slotted(async (dir: string): Promise<readonly string[]> => {
    try {
      return await readdir(dir);
    } catch (error) {
      return pathErrorOr(error, []);
    }
  }),
  // A regular file's permission bits, through a symlink if need be.
  fileMode = async (file: string): Promise<number> => {
    const info = await stat(file);
    return info.mode % MODE_SPAN;
  },
  tempFor = (file: string): string => path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`),
  // The temporary file renamed over the path; left behind by a failed rename, it is removed.
  renameOver = async (temp: string, file: string): Promise<void> => {
    try {
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  },
  replaceWith = async (file: string, content: Content): Promise<void> => {
    const temp = tempFor(file);
    await writeFile(temp, content.text, { encoding: content.encoding, flag: "wx", mode: content.mode });
    await renameOver(temp, file);
  },
  makeDir = async (dir: string): Promise<void> => {
    await safeFolder(dir, true);
  },
  // Text written whole: a reader never sees half a file.
  writeText = async (file: string, text: string): Promise<void> => {
    await safeFolder(path.dirname(file), false);
    await replaceWith(file, { encoding: "utf8", mode: FILE_MODE, text });
  },
  // Text written in a folder that may not exist yet.
  writeInto = async (file: string, text: string): Promise<void> => {
    await safeFolder(path.dirname(file), true);
    await replaceWith(file, { encoding: "utf8", mode: FILE_MODE, text });
  },
  // Binary text written back with the given permission bits, its folder made first when it is gone.
  writeBinary = async (file: string, text: string, mode: number = FILE_MODE): Promise<void> => {
    await safeFolder(path.dirname(file), true);
    await replaceWith(file, { encoding: "latin1", mode, text });
  },
  appendOpen = async (file: string, text: string): Promise<void> => {
    const handle = await open(file, APPEND_FLAGS, FILE_MODE);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink > ONE_LINK) {
        throw new UnsafePathError(`refusing to append to ${file}: it is not a regular file of its own`);
      }
      await handle.appendFile(text);
    } finally {
      await handle.close();
    }
  },
  appendText = async (file: string, text: string): Promise<void> => {
    await safeFolder(path.dirname(file), false);
    await appendOpen(file, text);
  },
  // Removed itself, never what it points to; nothing to do when a folder on the way is gone.
  removePath = async (target: string): Promise<void> => {
    try {
      await safeFolder(path.dirname(target), false);
    } catch (error) {
      if (codeOf(error) === "ENOENT") {
        return;
      }
      throw error;
    }
    await rm(target, { force: true, recursive: true });
  },
  movePath = async (from: string, to: string): Promise<void> => {
    await safeFolder(path.dirname(from), false);
    await safeFolder(path.dirname(to), false);
    await rename(from, to);
  },
  copyRegular = async (from: string, to: string): Promise<void> => {
    const temp = tempFor(to);
    await copyFile(from, temp, constants.COPYFILE_EXCL);
    await renameOver(temp, to);
  },
  // Only a regular file is copied, into a folder made when missing.
  copyInto = slotted(async (from: string, to: string): Promise<void> => {
    const info = await lstat(from);
    if (!info.isFile()) {
      throw new UnsafePathError(`refusing to copy ${from}: it is not a regular file`);
    }
    await safeFolder(path.dirname(to), true);
    await copyRegular(from, to);
  }),
  realPath = async (target: string): Promise<string> => {
    const real = await realpath(target);
    return real;
  },
  // Empty when the path does not resolve (gone, a loop, no permission).
  realPathOr = async (target: string): Promise<string> => {
    try {
      return await realpath(target);
    } catch (error) {
      return pathErrorOr(error, "");
    }
  },
  linkTo = async (target: string, link: string): Promise<void> => {
    await safeFolder(path.dirname(link), false);
    await symlink(target, link);
  },
  touch = async (target: string): Promise<void> => {
    const moment = new Date();
    await utimes(target, moment, moment);
  },
  modifiedAt = async (target: string): Promise<number> => {
    const info = await stat(target);
    return info.mtimeMs;
  },
  sizeOf = async (target: string): Promise<number> => {
    const info = await stat(target);
    return info.size;
  },
  // A regular file, itself: a symlink is not one, whatever it points to.
  isFile = slotted(async (target: string): Promise<boolean> => {
    try {
      const info = await lstat(target);
      return info.isFile();
    } catch (error) {
      return pathErrorOr(error, false);
    }
  }),
  // A folder, itself: a symlink to one is not.
  isFolder = slotted(async (target: string): Promise<boolean> => {
    try {
      const info = await lstat(target);
      return info.isDirectory();
    } catch (error) {
      return pathErrorOr(error, false);
    }
  });

export {
  appendText,
  copyInto,
  exists,
  FILE_MODE,
  fileMode,
  hashFile,
  isFile,
  isFolder,
  linkTo,
  listNames,
  makeDir,
  MISSING,
  modifiedAt,
  movePath,
  readBinary,
  readBinaryOr,
  readText,
  readTextIfThere,
  readTextOr,
  realPath,
  realPathOr,
  removePath,
  sizeOf,
  touch,
  writeBinary,
  writeInto,
  writeText,
};
