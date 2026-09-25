// The zero values a run's state starts from, and the fields every run (or unit) starts with.
import type { Acceptance, Confirmation, UnitsConfirmation } from "./types-progress.ts";
import type { Agent, Assignment } from "./types-config.ts";
import { DEFAULT_LEVELS, DEFAULT_LIMITS } from "./config-defaults.ts";
import type { Block } from "./types-block.ts";
import { NONE } from "./lists.ts";
import type { NoCall } from "./types-items.ts";
import type { RunState } from "./types-run.ts";
import type { StageMap } from "./types-names.ts";

type ProgressFields = Pick<RunState, "approved" | "blocked" | "calls" | "capBase" | "counts" | "deferred" | "denialStreak" | "devInput" | "dismissed" | "findings" | "history" | "historyBase" | "inflight" | "lastQa" | "lastReview" | "lastWork" | "retryCall" | "round" | "ruled" | "rulings" | "stageBase">;

interface Opening {
  readonly created: string;
  readonly log: string;
  readonly task: string;
}

const STATE_VERSION = 1,
  NO_CALL: NoCall = { kind: "none" },
  NO_BLOCK: Block = { info: {}, kind: "none", reason: "", since: "" },
  NO_CONFIRMATION: Confirmation = { at: "", hashes: { request: "", todoDev: "", todoQa: "" }, units: false, userSaid: "" },
  NO_ACCEPTANCE: Acceptance = { at: "", findings: [], userSaid: "" },
  NO_UNITS_CONFIRMATION: UnitsConfirmation = { at: "", userSaid: "" },
  PLACEHOLDER_AGENT: Agent = { effort: "", level: "standard", model: "", network: false, provider: "claude" },
  // Before a run starts it has no assignment yet; start replaces this one.
  NO_ASSIGNMENT: Assignment = {
    allowSameReviewer: false,
    crossProvider: false,
    levels: DEFAULT_LEVELS,
    limits: DEFAULT_LIMITS,
    sameReviewer: [],
    stages: {
      dev: { reviewer: PLACEHOLDER_AGENT, worker: PLACEHOLDER_AGENT },
      plan: { reviewer: PLACEHOLDER_AGENT, worker: PLACEHOLDER_AGENT },
      qa: { runner: PLACEHOLDER_AGENT },
      wiki: { reviewer: PLACEHOLDER_AGENT, worker: PLACEHOLDER_AGENT },
    },
    warnings: [],
  },
  stageMap = <Value>(make: () => Value): StageMap<Value> => ({ dev: make(), plan: make(), qa: make(), wiki: make() }),
  noText = (): string => "",
  noNumber = (): number => NONE,
  noList = (): readonly never[] => [],
  noRecord = (): Readonly<Record<string, never>> => ({}),
  // The progress fields a run (or a unit's run) starts its stages with.
  progressFields = (): ProgressFields => ({
    approved: stageMap(noText),
    blocked: NO_BLOCK,
    calls: [],
    capBase: stageMap(noNumber),
    counts: stageMap(noRecord),
    deferred: [],
    denialStreak: stageMap(noNumber),
    devInput: "",
    dismissed: stageMap(noList),
    findings: stageMap(noList),
    history: stageMap(noList),
    historyBase: stageMap(noNumber),
    inflight: NO_CALL,
    lastQa: "",
    lastReview: stageMap(noText),
    lastWork: {},
    retryCall: NO_CALL,
    round: stageMap(noNumber),
    ruled: stageMap(noList),
    rulings: [],
    stageBase: stageMap(noText),
  }),
  otherFields = (opening: Opening): Omit<RunState, keyof ProgressFields> => ({
    assignment: NO_ASSIGNMENT,
    baseRef: "",
    confirmations: [],
    confirmed: NO_CONFIRMATION,
    created: opening.created,
    currentFixCycle: NONE,
    fixCount: NONE,
    fixCycles: {},
    grants: {},
    idBase: NONE,
    lastQaFailing: [],
    levels: {},
    log: opening.log,
    loggedBlock: "",
    mainPrint: "",
    mainRoot: "",
    overrides: {},
    pending: "",
    permissionAsks: {},
    permissionDecisions: [],
    rawSeq: NONE,
    requestIds: {},
    runChanges: [],
    runDeleted: [],
    scope: [],
    secretFindings: [],
    secretsAccepted: NO_ACCEPTANCE,
    seedEpoch: NONE,
    seedSessions: {},
    seeding: [],
    stage: "intake",
    stageEnteredAt: stageMap(noText),
    task: opening.task,
    tickBases: {},
    title: "",
    unit: "",
    unitBase: "",
    unitHome: "",
    units: [],
    unitsConfirmed: NO_UNITS_CONFIRMATION,
    unitsMerged: "",
    unticked: {},
    untrackedAtStage: stageMap(noList),
    verdicts: [],
    verdictsSha: "",
    version: STATE_VERSION,
    workSessions: {},
  }),
  newRunState = (opening: Opening): RunState => Object.assign(progressFields(), otherFields(opening));

export { NO_ACCEPTANCE, NO_BLOCK, NO_CALL, NO_CONFIRMATION, NO_UNITS_CONFIRMATION, newRunState, progressFields };
