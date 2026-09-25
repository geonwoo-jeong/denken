/*
 * Finding SKILL.md files: the skills under skills/ (a SKILL.md shadows anything nested below it, as
 * in the skills CLI), and stray ones elsewhere, which the CLI would publish when skills/ is empty or
 * with --full-depth. Dot-directories hold installed skills and are skipped.
 */
import { access, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

type Entries = readonly Readonly<Dirent>[];

const exists = async (target: string): Promise<boolean> => {
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  },
  entriesOf = async (dir: string): Promise<Entries> => {
    const entries: Entries = await readdir(dir, { withFileTypes: true });
    return entries;
  },
  searched = (entry: Readonly<Dirent>): boolean => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
  // A folder's files that pass a test, found by a search of each sub-folder.
  inFolders = async (dir: string, search: (sub: string) => Promise<readonly string[]>): Promise<readonly string[]> => {
    const entries = await entriesOf(dir),
      nested = await Promise.all(
        entries
          .filter((entry) => searched(entry))
          .map(async (entry) => {
            const found = await search(path.join(dir, entry.name));
            return found;
          }),
      );
    return nested.flat();
  },
  findSkillFiles = async (dir: string): Promise<readonly string[]> => {
    const own = path.join(dir, "SKILL.md");
    if (!(await exists(dir))) {
      return [];
    }
    if (await exists(own)) {
      return [own];
    }
    return inFolders(dir, findSkillFiles);
  },
  // In the folder's own order: a SKILL.md here, or those found in a sub-folder (skills/ aside).
  findStraySkillFiles = async (dir: string, skillsDir: string): Promise<readonly string[]> => {
    const entries = await entriesOf(dir),
      found = await Promise.all(
        entries.map(async (entry): Promise<readonly string[]> => {
          const full = path.join(dir, entry.name);
          if (entry.isFile() && entry.name === "SKILL.md") {
            return [full];
          }
          if (searched(entry) && full !== skillsDir) {
            const nested = await findStraySkillFiles(full, skillsDir);
            return nested;
          }
          return [];
        }),
      );
    return found.flat();
  };

export { findSkillFiles, findStraySkillFiles };
