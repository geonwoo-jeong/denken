/*
 * Files, read and written without blocking: text, and "binary" text (latin1, one character per
 * byte). Bulk reads take a slot (fs-slot.ts). A path that cannot be used (missing, a loop of
 * symlinks, no permission, not a regular file) reads as the fallback the caller gives; running out
 * of resources is thrown. Only regular files are read, so a FIFO or a device never hangs a read.
 *
 * Writes never go through a symlink or a hard link a call planted: a file is written whole into a
 * new file beside it and renamed over the path, and the folders on the way are checked
 * (files-path.ts). An append opens the file without following a symlink and refuses a hard link.
 */
import { UnsafePathError, safeFolder } from "./files-path.ts";
import { access, copyFile, lstat, open, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pathErrorOr, slotted } from "./fs-slot.ts";
import { codeOf } from "./text.ts";
import { constants } from "node:fs";
import path from "node:path";

type Encoding = "latin1" | "utf8";

const MISSING = "missing",
  ABSENT: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]),
  ONE_LINK = 1,
  NEW_FILE_MODE = 0o666,
  MODE_BITS = 0o7777,
  // The open flags are single bits, so their sum is the set of all of them.
  APPEND_FLAGS = constants.O_WRONLY + constants.O_APPEND + constants.O_CREAT + constants.O_NOFOLLOW,
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
    const info = await stat(file);
    if (!info.isFile()) {
      throw new UnsafePathError(`${file} is not a regular file`);
    }
    return readFile(file, encoding);
  },
  readText = slotted(async (file: string): Promise<string> => {
    const text = await readRegular(file, "utf8");
    return text;
  }),
  readTextOr = slotted(async (file: string, fallback: string): Promise<string> => {
    try {
      return await readRegular(file, "utf8");
    } catch (error) {
      return pathErrorOr(error, fallback);
    }
  }),
  readBinaryOr = slotted(async (file: string, fallback: string): Promise<string> => {
    try {
      return await readRegular(file, "latin1");
    } catch (error) {
      return pathErrorOr(error, fallback);
    }
  }),
  // A path that is not there hashes as missing; one that cannot be read, as unreadable (a change, not an absence).
  hashFailure = (error: unknown): string => {
    const code = codeOf(error);
    if (ABSENT.has(code)) {
      return MISSING;
    }
    return pathErrorOr(error, `unreadable:${code}`);
  },
  hashData = async (file: string): Promise<string> => {
    const data = await readFile(file);
    return createHash("sha256").update(data).digest("hex");
  },
  // Only a regular file is read: a FIFO or a device behind a symlink would never end.
  hashFile = slotted(async (file: string): Promise<string> => {
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        return MISSING;
      }
      return await hashData(file);
    } catch (error) {
      return hashFailure(error);
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
  // The permission bits a replaced file keeps; a new file gets the default.
  modeOf = async (file: string): Promise<number> => {
    try {
      const info = await lstat(file);
      if (info.isFile()) {
        return info.mode % (MODE_BITS + ONE_LINK);
      }
      return NEW_FILE_MODE;
    } catch (error) {
      return pathErrorOr(error, NEW_FILE_MODE);
    }
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
  replaceWith = async (file: string, text: string, encoding: Encoding): Promise<void> => {
    const temp = tempFor(file);
    await writeFile(temp, text, { encoding, flag: "wx", mode: await modeOf(file) });
    await renameOver(temp, file);
  },
  makeDir = async (dir: string): Promise<void> => {
    await safeFolder(dir, true);
  },
  // Text written whole: a reader never sees half a file.
  writeText = async (file: string, text: string): Promise<void> => {
    await safeFolder(path.dirname(file), false);
    await replaceWith(file, text, "utf8");
  },
  // Text written in a folder that may not exist yet.
  writeInto = async (file: string, text: string): Promise<void> => {
    await safeFolder(path.dirname(file), true);
    await replaceWith(file, text, "utf8");
  },
  // Binary text written back, with its folder made first when it is gone.
  writeBinary = async (file: string, text: string): Promise<void> => {
    await safeFolder(path.dirname(file), true);
    await replaceWith(file, text, "latin1");
  },
  appendOpen = async (file: string, text: string): Promise<void> => {
    const handle = await open(file, APPEND_FLAGS, NEW_FILE_MODE);
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
  });

export {
  appendText,
  copyInto,
  exists,
  hashFile,
  isFile,
  linkTo,
  listNames,
  makeDir,
  MISSING,
  modifiedAt,
  movePath,
  readBinaryOr,
  readText,
  readTextOr,
  realPath,
  removePath,
  sizeOf,
  touch,
  writeBinary,
  writeInto,
  writeText,
};
