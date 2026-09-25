// Moving between stages: entering one, approving one, and finishing the run.
import { stageChanges } from "./changes.mjs";
import { EMPTY_TREE, EXCLUDE, NEXT_STAGE, now } from "./core.mjs";
import { gitText } from "./git.mjs";
import { scanSecrets, timeline, verdict } from "./record.mjs";
import { block } from "./state.mjs";

export function enterStage(state, stage) {
  state.stage = stage;
  state.pending = "work";
  // What this run changed, from the start of development to the end of QA: the wiki stage
  // documents exactly this.
  if (stage === "wiki") {
    state.runChanges = stageChanges(state, "dev").changed;
    state.runDeleted = gitText("diff", "--name-only", "--diff-filter=D", state.stageBase.dev || EMPTY_TREE, "--", ".", ...EXCLUDE).split("\n").filter(Boolean);
  }
  if (stage === "dev" || stage === "wiki") {
    state.stageBase[stage] = gitText("stash", "create") || gitText("rev-parse", "-q", "--verify", "HEAD") || EMPTY_TREE;
    (state.stageEnteredAt ??= {})[stage] = now();
    (state.untrackedAtStage ??= {})[stage] = gitText("ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE).split("\n").filter(Boolean);
  }
}

// The last verdict, and the digest of the finished verdicts.md, kept in the timeline and state.
export function finish(state) {
  if (state.unit) return verdict(state, "Unit", "ENGINE", "DONE", "planned, built, reviewed and verified on its own; it is merged when every unit is done");
  verdict(state, "Done", "ENGINE", "DONE", "every stage approved");
  timeline(state, "ENGINE", `verdicts.md sha256: ${state.verdictsSha}`);
}

// A unit ends with its own QA: the docs are written once, for the merged result.
export const nextStageOf = (state, stage) => (state.unit && stage === "qa" ? "done" : NEXT_STAGE[stage]);

export function approve(state, stage, evidence) {
  state.approved[stage] = evidence;
  const next = nextStageOf(state, stage);
  // The record is tracked in the project, so likely secrets in it stop the run before DONE.
  if (next === "done" && !state.unit) {
    state.secretFindings = scanSecrets(state);
    if (state.secretFindings.length) {
      timeline(state, "ENGINE", `secret scan: ${state.secretFindings.length} possible secret(s) in the record (${[...new Set(state.secretFindings.map((h) => h.file))].slice(0, 5).join(", ")})`);
      return block(state, "user", { reason: "secrets_in_record", resolveWith: "secrets", stage, findings: state.secretFindings });
    }
  }
  timeline(state, "ENGINE", next === "done" ? (state.unit ? "DONE: planned, built, reviewed and verified; waiting for the merge" : "DONE: every stage approved") : `${stage} approved → ${next}`);
  if (next === "done") finish(state);
  if (stage === "dev") state.devInput = null;
  enterStage(state, next);
  // Development starts only after the user has confirmed the scope and both TODO lists.
  if (stage === "plan") block(state, "user", { reason: "confirm_todos", resolveWith: "confirm", stage: "plan" });
}
