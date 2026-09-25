/*
 * DENKEN's files pinned before a call, to restore them from: content and permission bits. A file
 * that is there but cannot be read is pinned as unreadable, never as empty: restoring "" would erase
 * it. Logs, symlinks and folders that could not be read are not pinned.
 */
import { FILE_MODE, fileMode, readBinary } from "./files.ts";
import type { Pin, Pins } from "./types-work.ts";
import { SYMLINK, UNREADABLE_FOLDER } from "./guard-snapshot.ts";
import { ROOT } from "./paths.ts";
import type { Tree } from "./types-names.ts";
import { codeOf } from "./text.ts";
import { mapAsync } from "./lists.ts";
import path from "node:path";
import { pathErrorOr } from "./fs-slot.ts";

type Entry = readonly [string, Pin];

const ABSENT: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]),
  readPin = async (file: string): Promise<Pin> => {
    const content = await readBinary(file),
      mode = await fileMode(file);
    return { content, mode, unreadable: "" };
  },
  // The file's pin; none when it is not there.
  pinFile = async (file: string): Promise<readonly Pin[]> => {
    try {
      return [await readPin(file)];
    } catch (error) {
      if (ABSENT.has(codeOf(error))) {
        return [];
      }
      return pathErrorOr(error, [{ content: "", mode: FILE_MODE, unreadable: codeOf(error) }]);
    }
  },
  pinnable = (file: string, mark: string): boolean => !file.endsWith(".log") && !mark.startsWith(SYMLINK) && mark !== UNREADABLE_FOLDER,
  pinEntry = async (file: string): Promise<readonly Entry[]> => {
    const pins = await pinFile(path.join(ROOT, file));
    return pins.map((pin): Entry => [file, pin]);
  },
  pinOwned = async (owned: Tree): Promise<Pins> => {
    const entries = await mapAsync(
      Object.keys(owned).filter((file) => pinnable(file, owned[file] ?? "")),
      pinEntry,
    );
    return Object.fromEntries(entries.flat());
  };

export { pinFile, pinOwned };
