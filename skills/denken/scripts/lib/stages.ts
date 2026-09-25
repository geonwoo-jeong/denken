// Moving into a stage, and which stage comes after one.
import { EMPTY_TREE, EXCLUDE } from "./paths.ts";
import type { RunStage, Stage } from "./types-names.ts";
import { gitLines, gitText } from "./git.ts";
import { NEXT_STAGE } from "./stage-table.ts";
import type { RunState } from "./types-run.ts";
import type { RunStore } from "./types-store.ts";
import { now } from "./text.ts";
import { stageChanges } from "./changes.ts";
import { withStage } from "./stage-maps.ts";

const headOrEmpty = async (): Promise<string> => {
    const head = await gitText(["rev-parse", "-q", "--verify", "HEAD"]);
    return head || EMPTY_TREE;
  },
  // The project as it is now, uncommitted changes included, as a commit (or HEAD when clean).
  projectNow = async (): Promise<string> => {
    const stash = await gitText(["stash", "create"]);
    if (stash) {
      return stash;
    }
    return headOrEmpty();
  },
  // What this run changed, from the start of development to the end of QA: the wiki stage documents exactly this.
  noteRunChanges = async (store: RunStore): Promise<void> => {
    const state = store.current(),
      { changed } = await stageChanges(state, "dev"),
      deleted = await gitLines(["diff", "--name-only", "--diff-filter=D", state.stageBase.dev || EMPTY_TREE, "--", ".", ...EXCLUDE]);
    store.apply({ runChanges: changed, runDeleted: deleted });
  },
  markStageStart = async (store: RunStore, stage: Stage): Promise<void> => {
    const base = await projectNow(),
      entered = now(),
      untracked = await gitLines(["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE]),
      state = store.current();
    store.apply({
      stageBase: withStage(state.stageBase, stage, base),
      stageEnteredAt: withStage(state.stageEnteredAt, stage, entered),
      untrackedAtStage: withStage(state.untrackedAtStage, stage, untracked),
    });
  },
  enterStage = async (store: RunStore, stage: RunStage): Promise<void> => {
    store.apply({ pending: "work", stage });
    if (stage === "wiki") {
      await noteRunChanges(store);
    }
    if (stage === "dev" || stage === "wiki") {
      await markStageStart(store, stage);
    }
  },
  // A unit ends with its own QA: the docs are written once, for the merged result.
  nextStageOf = (state: RunState, stage: Stage): RunStage => {
    if (state.unit && stage === "qa") {
      return "done";
    }
    return NEXT_STAGE[stage];
  };

export { enterStage, nextStageOf };
