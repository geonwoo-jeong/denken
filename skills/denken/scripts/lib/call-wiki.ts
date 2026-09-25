// What SERIE is told: the files this run changed, the docs that mention them, and which must change.
import type { RunState } from "./types-run.ts";
import { framed } from "./text.ts";
import { relatedDocs } from "./wiki.ts";

const wikiNote = async (state: RunState): Promise<string> => {
  const docs = await relatedDocs(state.runChanges, state.runDeleted),
    must = docs.filter((doc) => doc.mustUpdate).map((doc) => doc.doc),
    mentions = docs.map((doc) => `${doc.doc} (${doc.mentions.join(", ")})`).join("; ") || "none";
  return `Files changed in this run: ${state.runChanges.join(", ") || "none"}${framed(" (deleted: ", state.runDeleted.join(", "), ")")}.\n  Existing docs that mention them: ${mentions}.${framed("\n  Must update, because they mention files this run deleted: ", must.join(", "), ".")}\n  Update only the documentation these changes affect: those docs, or a new page under docs/ when no existing page covers them. Leave unrelated pages alone, change no file that is not documentation, and do not touch agent configuration (CLAUDE.md, AGENTS.md, .claude/, .codex/, .agents/).`;
};

export { wikiNote };
