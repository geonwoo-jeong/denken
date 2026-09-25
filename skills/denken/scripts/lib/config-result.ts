// Resolving the configuration from the files read: the providers probed first, then every role.
import type { Agent, ConfigResult, ProviderStatuses, StageAgents } from "./types-config.ts";
import { DEFAULT_LEVELS, DEFAULT_LIMITS, DEFAULT_SEEDS, SUPPORTED, isProvider } from "./config-defaults.ts";
import type { ConfigLayer } from "./types-partc.ts";
import { allowedOf } from "./config-merge.ts";
import { isEmpty } from "./lists.ts";
import { probeAll } from "./config-probe.ts";
import { resolveAgents } from "./config-agents.ts";

interface Stopped {
  readonly errors: readonly string[];
  readonly sources: readonly string[];
  readonly status: ProviderStatuses;
}

const PLACEHOLDER: Agent = { effort: "", level: "standard", model: "", network: false, provider: "claude" },
  NO_STAGES: StageAgents = {
    dev: { reviewer: PLACEHOLDER, worker: PLACEHOLDER },
    plan: { reviewer: PLACEHOLDER, worker: PLACEHOLDER },
    qa: { runner: PLACEHOLDER },
    wiki: { reviewer: PLACEHOLDER, worker: PLACEHOLDER },
  },
  UNPROBED: ProviderStatuses = { claude: { problem: "" }, codex: { problem: "" } },
  // A result that stopped before the roles were resolved: its errors, and what was known by then.
  partialResult = (partial: Stopped): ConfigResult => ({
    allowSameReviewer: false,
    crossProvider: false,
    errors: partial.errors,
    levels: DEFAULT_LEVELS,
    limits: DEFAULT_LIMITS,
    resolved: false,
    sameReviewer: [],
    seeds: DEFAULT_SEEDS,
    sources: partial.sources,
    stages: NO_STAGES,
    status: partial.status,
    usable: [],
    warnings: [],
  }),
  brokenResult = (error: string): ConfigResult => partialResult({ errors: [error], sources: [], status: UNPROBED }),
  resolveFrom = async (root: string, layers: readonly ConfigLayer[]): Promise<ConfigResult> => {
    const allowed = allowedOf(layers),
      status = await probeAll(),
      usable = allowed.filter((provider) => isProvider(provider)).filter((provider) => !status[provider].problem),
      sources = layers.filter((layer) => layer.present).map((layer) => layer.path),
      providerErrors = allowed.filter((provider) => !isProvider(provider)).map((provider) => `unsupported provider "${provider}" (supported: ${SUPPORTED.join(", ")})`);
    if (isEmpty(usable)) {
      const shown = SUPPORTED.map((provider) => `${provider}: ${status[provider].problem || "ready"}`);
      return partialResult({ errors: [...providerErrors, `no usable provider (${shown.join(", ")}; allowed: ${allowed.join(", ")})`], sources, status });
    }
    return resolveAgents(root, { allowed, layers, providerErrors, sources, status, usable });
  };

export { brokenResult, resolveFrom };
