// A run's state.json: finding, loading and saving it, and the fields every run starts with.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, now, ROOT } from "./core.mjs";

export function runDirOf(arg) {
  if (!arg) fail("missing <run> argument");
  const dir = resolve(ROOT, arg);
  if (!existsSync(join(dir, "state.json"))) fail(`not a run directory: ${arg}`);
  return dir;
}

export function load(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  } catch (e) {
    fail(`${join(dir, "state.json")} is unreadable: ${e.message}`);
  }
}

export function save(dir, state) {
  const tmp = join(dir, "state.json.tmp");
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, join(dir, "state.json"));
}

export const callBase = (dir, id) => join(dir, "calls", id);

// ---------- file guard

export const readRunFile = (runDir, name) => (existsSync(join(runDir, name)) ? readFileSync(join(runDir, name), "utf8") : "");

// The parent's fields every run needs, for a new run or a unit's.
export function runFields(assignment, baseRef) {
  return {
    assignment,
    baseRef,
    round: { plan: 0, dev: 0, qa: 0, wiki: 0 },
    stageBase: {},
    counts: { plan: {}, dev: {}, wiki: {} },
    findings: { plan: [], dev: [], wiki: [] },
    history: { plan: [], dev: [], wiki: [] },
    historyBase: {},
    capBase: {},
    dismissed: {},
    ruled: {},
    denialStreak: {},
    lastReview: {},
    lastWork: {},
    lastQa: null,
    devInput: null,
    deferred: [],
    rulings: [],
    approved: { plan: null, dev: null, qa: null, wiki: null },
    calls: [],
    inflight: null,
    blocked: null,
    retryCall: null,
  };
}

export function block(state, kind, details) {
  state.blocked = { kind, since: now(), ...details };
}
