// What a reviewer is told about the stage so far: the topics raised, the ones dismissed, and the worker's blocked actions.
import { NONE, hasItems, lastOf, unique } from "./lists.ts";
import type { RunState } from "./types-run.ts";
import { START } from "./text.ts";
import type { Stage } from "./types-names.ts";
import type { StoredFinding } from "./types-items.ts";
import { toLine } from "./json.ts";

const INPUT_MAX = 200,
  // Each identity once, where it was first raised, with what its latest occurrence says.
  knownTopics = (state: RunState, stage: Stage): readonly StoredFinding[] =>
    unique(state.findings[stage].map((finding) => finding.identity)).flatMap((identity) => {
      const latest = lastOf(state.findings[stage].filter((finding) => finding.identity === identity));
      if (latest) {
        return [latest];
      }
      return [];
    }),
  topicsNote = (state: RunState, stage: Stage): readonly string[] => {
    const topics = knownTopics(state, stage);
    if (!hasItems(topics)) {
      return [];
    }
    return [
      `Known topics in this stage. For the same issue, reuse the same topic, file and request_item:\n${topics
        .map((topic) => `  - ${topic.identity} (topic "${topic.topic}", file ${topic.file || "none"}, request_item ${topic.request_item || "none"}, raised ${state.counts[stage][topic.identity] ?? NONE}x)`)
        .join("\n")}`,
    ];
  },
  dismissedNote = (state: RunState, stage: Stage): readonly string[] => {
    const dismissed = state.dismissed[stage];
    if (!hasItems(dismissed)) {
      return [];
    }
    return [`Dismissed by DENKEN. Do not raise these again: ${dismissed.join(", ")}`];
  },
  denialsNote = (state: RunState, stage: Stage): readonly string[] => {
    const { denials } = state.lastWork[stage] ?? { denials: [] };
    if (!hasItems(denials)) {
      return [];
    }
    return [
      `The worker had ${denials.length} action(s) blocked by permissions in its last call. Check that nothing the work depends on was skipped:\n${denials
        .map((denial) => `  - ${denial.tool}: ${toLine(denial.input).slice(START, INPUT_MAX)}`)
        .join("\n")}`,
    ];
  };

export { denialsNote, dismissedNote, topicsNote };
