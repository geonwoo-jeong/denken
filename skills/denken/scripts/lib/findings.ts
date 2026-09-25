// Review findings: their identities, repeated topics, and when DENKEN is called in.
import type { Finding, StoredFinding } from "./types-items.ts";
import { NONE, entriesOf, increment, isEmpty, patch, unique, withEntry } from "./lists.ts";
import type { Stage, TextMap } from "./types-names.ts";
import type { ReviewRecord } from "./types-parta.ts";
import type { RunStore } from "./types-store.ts";
import { block } from "./blocks.ts";
import { slug } from "./text.ts";
import { withStage } from "./stage-maps.ts";

const JACCARD_MIN = 0.5,
  STALL_ROUNDS = 3,
  FILE_SUFFIX = /:\d+.*$/u,
  REQUEST_ID = /^REQ-\d{3,}$/u,
  fileOf = (finding: Finding): string => finding.file.replace(FILE_SUFFIX, ""),
  tokensOf = (text: string): readonly string[] => unique(slug(text).split("-").filter(Boolean)),
  similar = (mine: readonly string[], theirs: readonly string[]): boolean => {
    const shared = mine.filter((token) => theirs.includes(token)).length;
    return shared / (mine.length + theirs.length - shared) >= JACCARD_MIN;
  },
  /*
   * A finding's identity decides what counts as "the same topic". A request item wins; otherwise
   * file plus topic, where a slightly renamed topic on the same file (token Jaccard >= 0.5)
   * is merged into the known identity.
   */
  identityOf = (finding: Finding, known: readonly StoredFinding[]): string => {
    if (finding.identity) {
      return finding.identity;
    }
    if (REQUEST_ID.test(finding.request_item)) {
      return finding.request_item;
    }
    const file = fileOf(finding),
      mine = tokensOf(finding.topic),
      match = known.find((other) => !other.request_item && fileOf(other) === file && similar(mine, tokensOf(other.topic)));
    if (match) {
      return match.identity;
    }
    if (file) {
      return `${file}::${slug(finding.topic)}`;
    }
    return slug(finding.topic);
  },
  blockRepeated = (store: RunStore, stage: Stage, repeated: readonly [string, number]): void => {
    const [identity, count] = repeated,
      state = store.current(),
      limit = state.assignment.limits.topicRepeats,
      occurrences = state.findings[stage].filter((finding) => finding.identity === identity);
    if (state.ruled[stage].includes(identity)) {
      block(store, "user", { info: { count, identity, limit, occurrences, resolveWith: "rule", stage }, reason: "topic_repeated_after_ruling" });
      return;
    }
    block(store, "ruling", { info: { count, identity, limit, occurrences, rule: `raised ${count} times (limit ${limit})`, stage }, reason: "topic_repeated" });
  },
  isStalled = (last: readonly number[]): boolean => {
    const [first = NONE, second = NONE, third = NONE] = last;
    return last.length === STALL_ROUNDS && first > NONE && third >= second && second >= first;
  },
  checkThresholds = (store: RunStore, stage: Stage): void => {
    const state = store.current(),
      { roundsPerStage, topicRepeats } = state.assignment.limits,
      repeated = entriesOf(state.counts[stage]).find(([, count]) => count >= topicRepeats),
      last = state.history[stage]
        .slice(state.historyBase[stage])
        .slice(-STALL_ROUNDS)
        .map((entry) => entry.blocking),
      rounds = state.round[stage] - state.capBase[stage];
    if (repeated) {
      blockRepeated(store, stage, repeated);
    } else if (isStalled(last)) {
      block(store, "ruling", { info: { blockingPerRound: last, rule: `blocking findings per round ${last.join(" → ")}, not going down`, stage }, reason: "stalled" });
    } else if (rounds >= roundsPerStage) {
      block(store, "ruling", { info: { limit: roundsPerStage, rounds: state.round[stage], rule: `${rounds} rounds (limit ${roundsPerStage})`, stage }, reason: "round_cap" });
    }
  },
  storedOf = (finding: Finding, review: ReviewRecord): StoredFinding => Object.assign(structuredClone(finding), { call: review.call.id, round: review.call.round, stage: review.stage }),
  countsAfter = (counts: TextMap<number>, identities: readonly string[]): TextMap<number> => {
    let next = counts;
    for (const identity of unique(identities)) {
      next = withEntry(next, identity, increment(next[identity] ?? NONE));
    }
    return next;
  },
  /*
   * Records a round's findings (a reviewer's, or the engine's coverage gaps) and returns the
   * number of blocking ones. With any left, the stage goes back to its worker.
   */
  recordReview = (store: RunStore, review: ReviewRecord): number => {
    const state = store.current(),
      { call, stage } = review,
      findings = review.findings
        .map((finding) => patch(finding, { identity: identityOf(finding, state.findings[stage]) }))
        .filter((finding) => !state.dismissed[stage].includes(finding.identity)),
      blocking = findings.filter((finding) => finding.severity === "blocking"),
      deferred = findings.filter((finding) => finding.severity === "nonblocking").map((finding) => storedOf(finding, review)),
      raised = blocking.map((finding) => patch(storedOf(finding, review), { source: finding.source || "review" })),
      counts = withStage(state.counts, stage, countsAfter(state.counts[stage], blocking.map((finding) => finding.identity)));
    store.apply({ deferred: [...state.deferred, ...deferred], history: withStage(state.history, stage, [...state.history[stage], { blocking: blocking.length, round: call.round }]) });
    if (isEmpty(blocking)) {
      return NONE;
    }
    store.apply({
      counts,
      findings: withStage(store.current().findings, stage, [...store.current().findings[stage], ...raised]),
      pending: "work",
    });
    checkThresholds(store, stage);
    return blocking.length;
  };

export { checkThresholds, fileOf, identityOf, recordReview };
