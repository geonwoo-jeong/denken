// A unit changes only files in its scope: anything else could collide with another unit.
import type { Finding } from "./types-items.ts";
import type { RunState } from "./types-run.ts";
import { engineFinding } from "./engine-finding.ts";
import { inScope } from "./units-plan.ts";
import { stageChanges } from "./changes.ts";

const unitScopeGaps = async (state: RunState): Promise<readonly Finding[]> => {
    if (!state.unit) {
      return [];
    }
    const { changed } = await stageChanges(state, "dev");
    return changed
      .filter((file) => !inScope(state.scope, file))
      .map((file) =>
        engineFinding({
          file,
          identity: `scope-${file}`,
          problem: `${file} changed, outside ${state.unit}'s scope (${state.scope.join(", ")})`,
          required_change: `Undo the change to ${file}. If an item cannot be done without it, report the item blocked in dev-report.md with the reason: DENKEN will change the split.`,
        }),
      );
  };

export { unitScopeGaps };
