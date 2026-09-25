// Workers continuing their own session across rounds.
import { existsSync, statSync } from "node:fs";
import { sha, TODO_DEV, TODO_FIX } from "./core.mjs";
import { profileOf, SEED_REWARM_MS } from "./seeds.mjs";

// ---------- workers continue their own session
// A worker's next round in a stage continues its previous round's session: it remembers what it did
// and why, and the cache still holds it (Codex keys its cache by session, so only this reuses it).
// A session serves at most CONTINUE_ROUNDS rounds; then the worker starts clean again, before the
// conversation grows long enough to crowd out the plan. Checkers never continue: each review and
// QA round judges the work as it is now, not anchored to the verdict it gave last time.
// A session is not continued when:
// - its cache has likely expired: the whole grown conversation would be sent again, uncached, which
//   costs more than a clean start;
// - QA has failed again: the session holds its own case for the work QA keeps rejecting.
export const CONTINUE_ROUNDS = 3;

export function continueFor(state, call, agent) {
  if (call.mode !== "work") return null;
  const prev = state.workSessions?.[call.role];
  const profile = sha(JSON.stringify(profileOf(state, call, agent)));
  if (!prev || prev.stage !== call.stage || prev.profile !== profile || prev.epoch !== (state.seedEpoch ?? 0) || prev.chain >= CONTINUE_ROUNDS) return null;
  if (Date.now() - Date.parse(prev.at) > SEED_REWARM_MS) return null;
  if (call.stage === "dev" && state.devInput === "qa" && (state.currentFixCycle ?? 0) >= 2) return null;
  return { sessionId: prev.sessionId, chain: prev.chain, from: prev.call, since: prev.at };
}

// What the engine and others did since the worker's session last ran, which its memory lacks.
export function sinceLastCall(runDir, state, call, since) {
  const lines = [];
  const unticked = Object.entries(state.unticked ?? {}).filter(([, u]) => u.at > since).map(([k, u]) => `${k} (after QA cycle ${u.cycle})`);
  if (unticked.length) lines.push(`the engine unticked ${unticked.join(", ")}: QA failed for the request items they serve`);
  for (const [cycle, c] of Object.entries(state.fixCycles ?? {})) if (c.at > since) lines.push(`QA cycle ${cycle} failed; the engine wrote ${c.items.join(", ")} to ${TODO_FIX}`);
  if (call.stage === "dev") lines.push(`the engine wrote the ticks you recorded, with their evidence, into ${TODO_DEV}`);
  for (const r of state.rulings ?? []) if (r.at > since) lines.push(`DENKEN's ruling ${r.id} (${r.decision}) on ${r.subject}: see rulings.md`);
  const review = state.lastReview[call.stage];
  if (review && existsSync(review) && statSync(review).mtime.toISOString() > since) lines.push(`a review of your last round came back; it is listed under Read`);
  return lines;
}
