/*
 * Folders listed without following symlinks: a symlink an agent plants must never make the engine
 * read, copy or delete what it points to. listFiles gives regular files; listPaths also gives each
 * symlink itself, as the guard must see it.
 */
import { lstat, readdir, readlink } from "node:fs/promises";
import { pathErrorOr, slotted } from "./fs-slot.ts";
import type { Dirent } from "node:fs";
import path from "node:path";

type Entries = readonly Readonly<Dirent>[];

const readEntries = slotted(async (dir: string): Promise<Entries> => {
    try {
      const entries: Entries = await readdir(dir, { withFileTypes: true });
      return entries;
    } catch (error) {
      return pathErrorOr(error, []);
    }
  }),
  // Where a symlink points; empty when the path is not a symlink (or not there).
  linkTarget = slotted(async (target: string): Promise<string> => {
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        return await readlink(target);
      }
      return "";
    } catch (error) {
      return pathErrorOr(error, "");
    }
  }),
  // Every path under a folder, depth first: regular files, plus symlinks when links is set.
  walk = async (dir: string, links: boolean): Promise<readonly string[]> => {
    const entries = await readEntries(dir),
      nested = await Promise.all(
        entries.map(async (entry): Promise<readonly string[]> => {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const inner = await walk(full, links);
            return inner;
          }
          if (entry.isFile() || (links && entry.isSymbolicLink())) {
            return [full];
          }
          return [];
        }),
      );
    return nested.flat();
  },
  // Regular files under a folder; a folder that is itself a symlink has none.
  listFiles = async (dir: string): Promise<readonly string[]> => {
    if (await linkTarget(dir)) {
      return [];
    }
    const files = await walk(dir, false);
    return files;
  },
  // Files and symlinks under a folder; a folder that is itself a symlink is listed as that symlink.
  listPaths = async (dir: string): Promise<readonly string[]> => {
    if (await linkTarget(dir)) {
      return [dir];
    }
    const paths = await walk(dir, true);
    return paths;
  };

export { linkTarget, listFiles, listPaths };
