// The files a DEV item names, for the check that a unit's plan stays inside its scope.
import { allGroups, groupOf } from "./text.ts";
import { mapAsync, unique } from "./lists.ts";
import { EVIDENCE_LINE } from "./todo.ts";
import { ROOT } from "./paths.ts";
import type { TodoItem } from "./types-todo.ts";
import { exists } from "./files.ts";
import path from "node:path";

const FILES_LIST = /\bFiles:\s*(?<files>.*?)(?:\.\s+[A-Z]|\bUnit tests:|$)/u,
  PATH_LIKE = /^[\w@./-]+$/u,
  candidates = (item: TodoItem): readonly string[] => {
    const text = item.block
        .split("\n")
        .filter((line) => !EVIDENCE_LINE.test(line))
        .join(" "),
      listed = groupOf(FILES_LIST, text, "files").split(/[\s,;()]+/u),
      quoted = allGroups(/`(?<name>[^`\s]+)`/gu, text, "name").filter((name) => name.includes("/"));
    return unique([...listed, ...quoted].map((name) => name.replaceAll(/^[`'"]+|[`'".:]+$/gu, ""))).filter(
      (name) => PATH_LIKE.test(name) && !name.startsWith("/") && !name.includes("..") && (name.includes("/") || /\.\w+$/u.test(name)),
    );
  },
  // A name counts when it exists in the project, or its folder does (a new file).
  existsInProject = async (name: string): Promise<boolean> =>
    (await exists(path.join(ROOT, name))) || (path.dirname(name) !== "." && (await exists(path.join(ROOT, path.dirname(name))))),
  /*
   * The files a DEV item names: its "Files:" list, and paths in backticks. A name counts when it
   * exists in the project, or its folder does (a new file); code such as `text.length` does not.
   */
  namedPaths = async (item: TodoItem): Promise<readonly string[]> => {
    const names = candidates(item),
      found = await mapAsync(names, existsInProject);
    return names.filter((_name, index) => found[index] === true);
  };

export { namedPaths };
