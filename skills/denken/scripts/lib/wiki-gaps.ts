// The check that the wiki stage changed only documentation.
import type { Finding } from "./types-items.ts";
import type { RunState } from "./types-run.ts";
import { engineFinding } from "./engine-finding.ts";
import { isDoc } from "./wiki.ts";
import { stageChanges } from "./changes.ts";

// After SERIE's call: in the wiki stage only documentation may change.
const wikiGaps = async (state: RunState): Promise<readonly Finding[]> => {
  const { changed } = await stageChanges(state, "wiki");
  return changed
    .filter((file) => !isDoc(file))
    .map((file) =>
      engineFinding({
        file,
        identity: `wiki-nondoc-${file}`,
        problem: `${file} changed in the wiki stage, and it is not documentation`,
        required_change: `Undo your change to ${file}. In the wiki stage only documentation may change; report code problems under known limitations instead.`,
        topic: "wiki-nondoc",
      }),
    );
};

export { wikiGaps };
