// The configuration: which provider, model and effort plays each role, and the limits of a run.
type Provider = "claude" | "codex";

type Level = "heavy" | "light" | "standard";

// An agent as a role runs it. An empty model or effort means the provider's default.
interface Agent {
  readonly effort: string;
  readonly level: Level;
  readonly model: string;
  readonly network: boolean;
  readonly provider: Provider;
}

// What DENKEN granted a role on request, beyond its defaults.
interface Grants {
  readonly dirs: readonly string[];
  readonly domains: readonly string[];
  readonly network: boolean;
  readonly tools: readonly string[];
}

interface Limits {
  readonly callTimeoutMin: number;
  readonly parallelUnits: number;
  readonly roundsPerStage: number;
  readonly topicRepeats: number;
}

// What a level means on a provider: an empty model or effort leaves the role's own.
interface LevelSpec {
  readonly effort: string;
  readonly model: string;
}

interface ProviderLevels {
  readonly heavy: LevelSpec;
  readonly light: LevelSpec;
}

interface LevelTable {
  readonly claude: ProviderLevels;
  readonly codex: ProviderLevels;
}

interface SeedSwitches {
  readonly claude: boolean;
  readonly codex: boolean;
}

interface PairAgents {
  readonly reviewer: Agent;
  readonly worker: Agent;
}

interface QaAgents {
  readonly runner: Agent;
}

interface StageAgents {
  readonly dev: PairAgents;
  readonly plan: PairAgents;
  readonly qa: QaAgents;
  readonly wiki: PairAgents;
}

// A provider's readiness: an empty problem means it is ready.
interface ProviderStatus {
  readonly problem: string;
}

interface ProviderStatuses {
  readonly claude: ProviderStatus;
  readonly codex: ProviderStatus;
}

// The resolved configuration. With errors, the fields after them may be incomplete.
interface ConfigResult {
  readonly allowSameReviewer: boolean;
  readonly crossProvider: boolean;
  readonly errors: readonly string[];
  readonly levels: LevelTable;
  readonly limits: Limits;
  readonly resolved: boolean;
  readonly sameReviewer: readonly string[];
  readonly seeds: SeedSwitches;
  readonly sources: readonly string[];
  readonly stages: StageAgents;
  readonly status: ProviderStatuses;
  readonly usable: readonly Provider[];
  readonly warnings: readonly string[];
}

// The part of the configuration a run keeps for itself when it starts.
interface Assignment {
  readonly allowSameReviewer: boolean;
  readonly crossProvider: boolean;
  readonly levels: LevelTable;
  readonly limits: Limits;
  readonly sameReviewer: readonly string[];
  readonly stages: StageAgents;
  readonly warnings: readonly string[];
}

export type {
  Agent,
  Assignment,
  ConfigResult,
  Grants,
  Level,
  LevelSpec,
  LevelTable,
  Limits,
  PairAgents,
  Provider,
  ProviderLevels,
  ProviderStatus,
  ProviderStatuses,
  QaAgents,
  SeedSwitches,
  StageAgents,
};
