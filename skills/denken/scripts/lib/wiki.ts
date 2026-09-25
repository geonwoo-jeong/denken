// The docs a run's changes touch, and the check that the wiki stage changed only docs.
import { EXCLUDE, ROOT } from "./paths.ts";
import { NONE, increment, mapAsync, unique } from "./lists.ts";
import { START, escapeRegExp } from "./text.ts";
import { AGENT_CONTEXT } from "./guard.ts";
import type { RelatedDoc } from "./types-work.ts";
import { gitLines } from "./git.ts";
import path from "node:path";
import { readTextOr } from "./files.ts";

const DOCS_MAX = 10,
  NAME_MIN = 3,
  ONLY_ONE = 1,
  // Documentation, as far as the wiki stage is concerned.
  isDoc = (file: string): boolean => !AGENT_CONTEXT.test(file) && (/\.(?:md|mdx|rst|adoc)$/iu.test(file) || /(?:^|\/)(?:docs?|wiki)\//iu.test(file)),
  /*
   * Existing docs that mention a changed code file: by path, or by its name without extension when
   * that name is unique in the project and not a generic one. Docs mentioning a deleted file must be
   * updated. The list is capped so a common name cannot flood SERIE.
   */
  GENERIC_NAMES: ReadonlySet<string> = new Set([
    "index",
    "main",
    "utils",
    "util",
    "config",
    "api",
    "app",
    "types",
    "type",
    "test",
    "tests",
    "readme",
    "lib",
    "src",
    "helpers",
    "helper",
    "common",
    "constants",
    "core",
    "base",
    "model",
    "models",
    "mod",
    "init",
    "setup",
    "server",
    "client",
  ]),
  nameOf = (file: string): string => path.basename(file).replace(/\.[^.]+$/u, ""),
  // Names that only one file in the project (or among the deleted files) has.
  singleNames = (names: readonly string[]): readonly string[] => {
    const counts = new Map<string, number>();
    for (const name of names) {
      counts.set(name, increment(counts.get(name) ?? NONE));
    }
    return [...counts.keys()].filter((name) => counts.get(name) === ONLY_ONE);
  },
  // Whether a code file's bare name can stand for it: unique in the project, long enough, not generic.
  nameStandsFor = (file: string, single: readonly string[]): boolean => {
    const name = nameOf(file);
    return single.includes(name) && name.length >= NAME_MIN && !GENERIC_NAMES.has(name.toLowerCase());
  },
  readDoc = async (doc: string): Promise<string> => {
    const text = await readTextOr(path.join(ROOT, doc), "");
    return text;
  },
  mentionsIn = (text: string, code: readonly string[], single: readonly string[]): readonly (readonly string[])[] => {
    const byPath = code.filter((file) => text.includes(file)),
      byName = code.filter(
        (file) => !byPath.includes(file) && nameStandsFor(file, single) && new RegExp(String.raw`\b${escapeRegExp(nameOf(file))}\b`, "u").test(text),
      );
    return [byPath, byName];
  },
  byRelevance = (left: RelatedDoc, right: RelatedDoc): number =>
    Number(right.mustUpdate) - Number(left.mustUpdate) || right.byPath - left.byPath || right.mentions.length - left.mentions.length,
  relatedDocs = async (changed: readonly string[], deleted: readonly string[]): Promise<readonly RelatedDoc[]> => {
    const tracked = await gitLines(["ls-files", "--", ".", ...EXCLUDE]),
      untracked = await gitLines(["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE]),
      files = unique([...tracked, ...untracked]),
      docs = files.filter((file) => isDoc(file)),
      single = singleNames([...files, ...deleted].map((file) => nameOf(file))),
      code = unique([...changed, ...deleted]).filter((file) => !isDoc(file) && !AGENT_CONTEXT.test(file)),
      texts = await mapAsync(docs, readDoc);
    return docs
      .flatMap((doc, index): readonly RelatedDoc[] => {
        const [byPath = [], byName = []] = mentionsIn(texts[index] ?? "", code, single),
          mentions = [...byPath, ...byName];
        if (mentions.length === START) {
          return [];
        }
        return [{ byPath: byPath.length, doc, mentions, mustUpdate: mentions.some((file) => deleted.includes(file)) }];
      })
      .toSorted(byRelevance)
      .slice(START, DOCS_MAX);
  };

export { GENERIC_NAMES, isDoc, relatedDocs };
