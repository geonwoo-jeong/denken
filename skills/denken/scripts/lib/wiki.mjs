// The docs a run's changes touch, and the check that the wiki stage changed only docs.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stageChanges } from "./changes.mjs";
import { EXCLUDE, ROOT } from "./core.mjs";
import { gitText } from "./git.mjs";
import { AGENT_CONTEXT } from "./guard.mjs";

// Documentation, as far as the wiki stage is concerned.
export const isDoc = (f) => !AGENT_CONTEXT.test(f) && (/\.(md|mdx|rst|adoc)$/i.test(f) || /(^|\/)(docs?|wiki)\//i.test(f));

// Existing docs that mention a changed code file: by path, or by its name without extension when
// that name is unique in the project and not a generic one. Docs mentioning a deleted file must be
// updated. The list is capped so a common name cannot flood SERIE.
export const GENERIC_NAMES = new Set(["index", "main", "utils", "util", "config", "api", "app", "types", "type", "test", "tests", "readme", "lib", "src", "helpers", "helper", "common", "constants", "core", "base", "model", "models", "mod", "init", "setup", "server", "client"]);

export function relatedDocs(changed, deleted = []) {
  const lines = (text) => text.split("\n").filter(Boolean);
  const files = [...new Set([...lines(gitText("ls-files", "--", ".", ...EXCLUDE)), ...lines(gitText("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE))])];
  const docs = files.filter(isDoc);
  const nameOf = (f) => basename(f).replace(/\.[^.]+$/, "");
  const counts = new Map();
  for (const f of [...files, ...deleted]) counts.set(nameOf(f), (counts.get(nameOf(f)) ?? 0) + 1);
  const code = [...new Set([...changed, ...deleted])].filter((f) => !isDoc(f) && !AGENT_CONTEXT.test(f));
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = [];
  for (const doc of docs) {
    let text;
    try {
      text = readFileSync(join(ROOT, doc), "utf8");
    } catch {
      continue;
    }
    const byPath = code.filter((f) => text.includes(f));
    const byName = code.filter((f) => !byPath.includes(f) && counts.get(nameOf(f)) === 1 && nameOf(f).length >= 3 && !GENERIC_NAMES.has(nameOf(f).toLowerCase()) && new RegExp(`\\b${escape(nameOf(f))}\\b`).test(text));
    const mentions = [...byPath, ...byName];
    if (mentions.length) found.push({ doc, mentions, byPath: byPath.length, mustUpdate: mentions.some((f) => deleted.includes(f)) });
  }
  return found.sort((x, y) => Number(y.mustUpdate) - Number(x.mustUpdate) || y.byPath - x.byPath || y.mentions.length - x.mentions.length).slice(0, 10);
}

// After SERIE's call: in the wiki stage only documentation may change.
export function wikiGaps(state) {
  return stageChanges(state, "wiki")
    .changed.filter((f) => !isDoc(f))
    .map((f) => ({
      identity: `wiki-nondoc-${f}`,
      severity: "blocking",
      topic: "wiki-nondoc",
      file: f,
      line_start: null,
      line_end: null,
      request_item: null,
      todo: null,
      problem: `${f} changed in the wiki stage, and it is not documentation`,
      required_change: `Undo your change to ${f}. In the wiki stage only documentation may change; report code problems under known limitations instead.`,
      source: "engine",
    }));
}
