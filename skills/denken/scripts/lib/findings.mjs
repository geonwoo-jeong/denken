// Review findings: their identities, repeated topics, and when DENKEN is called in.
import { slug } from "./core.mjs";
import { block } from "./state.mjs";

export const fileOf = (f) => (f.file ? String(f.file).replace(/:\d+.*$/, "") : null);

export const tokens = (text) => new Set(slug(text).split("-").filter(Boolean));

// A finding's identity decides what counts as "the same topic". A request item wins; otherwise
// file plus topic, where a slightly renamed topic on the same file (token Jaccard >= 0.5)
// is merged into the known identity.
export function identityOf(f, known) {
  if (f.identity) return f.identity;
  if (typeof f.request_item === "string" && /^REQ-\d{3,}$/.test(f.request_item)) return f.request_item;
  const file = fileOf(f);
  const mine = tokens(f.topic);
  for (const k of known) {
    if (k.request_item || fileOf(k) !== file) continue;
    const theirs = tokens(k.topic);
    const shared = [...mine].filter((t) => theirs.has(t)).length;
    if (shared / (mine.size + theirs.size - shared) >= 0.5) return k.identity;
  }
  return file ? `${file}::${slug(f.topic)}` : slug(f.topic);
}

export function checkThresholds(state, stage) {
  const { topicRepeats, roundsPerStage } = state.assignment.limits;
  const repeated = Object.entries(state.counts[stage] ?? {}).find(([, n]) => n >= topicRepeats);
  if (repeated) {
    const [identity] = repeated;
    const occurrences = (state.findings[stage] ?? []).filter((f) => f.identity === identity);
    if ((state.ruled[stage] ?? []).includes(identity)) {
      return block(state, "user", { reason: "topic_repeated_after_ruling", resolveWith: "rule", stage, identity, occurrences, count: repeated[1], limit: topicRepeats });
    }
    return block(state, "ruling", { reason: "topic_repeated", stage, identity, occurrences, count: repeated[1], limit: topicRepeats, rule: `raised ${repeated[1]} times (limit ${topicRepeats})` });
  }
  const history = state.history[stage].slice(state.historyBase[stage] ?? 0);
  const last = history.slice(-3).map((h) => h.blocking);
  if (last.length === 3 && last[0] > 0 && last[2] >= last[1] && last[1] >= last[0]) {
    return block(state, "ruling", { reason: "stalled", stage, blockingPerRound: last, rule: `blocking findings per round ${last.join(" → ")}, not going down` });
  }
  if (state.round[stage] - (state.capBase[stage] ?? 0) >= roundsPerStage) {
    return block(state, "ruling", { reason: "round_cap", stage, rounds: state.round[stage], limit: roundsPerStage, rule: `${state.round[stage] - (state.capBase[stage] ?? 0)} rounds (limit ${roundsPerStage})` });
  }
}

// Records a round's findings (a reviewer's, or the engine's coverage gaps) and returns the
// number of blocking ones. With any left, the stage goes back to its worker.
export function recordReview(state, stage, call, raw) {
  const dismissed = new Set(state.dismissed[stage] ?? []);
  const findings = raw.map((f) => ({ ...f, identity: identityOf(f, state.findings[stage]) })).filter((f) => !dismissed.has(f.identity));
  const blocking = findings.filter((f) => f.severity === "blocking");
  for (const f of findings.filter((f) => f.severity === "nonblocking")) state.deferred.push({ stage, round: call.round, call: call.id, ...f });
  state.history[stage].push({ round: call.round, blocking: blocking.length });
  if (blocking.length === 0) return 0;
  state.pending = "work";
  for (const f of blocking) state.findings[stage].push({ round: call.round, call: call.id, identity: f.identity, topic: f.topic, file: f.file, request_item: f.request_item ?? null, todo: f.todo ?? null, source: f.source ?? "review", problem: f.problem, required_change: f.required_change });
  for (const identity of new Set(blocking.map((f) => f.identity))) state.counts[stage][identity] = (state.counts[stage][identity] ?? 0) + 1;
  checkThresholds(state, stage);
  return blocking.length;
}

// ---------- actions shown to DENKEN
