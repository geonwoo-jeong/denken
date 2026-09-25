// The configuration's defaults: providers, limits, levels, efforts and FLAMME's seeds.
import type { Level, LevelTable, Limits, Provider, SeedSwitches } from "./types-config.ts";

const SUPPORTED: readonly Provider[] = ["claude", "codex"],
  DEFAULT_LIMITS: Limits = { callTimeoutMin: 60, parallelUnits: 3, roundsPerStage: 5, topicRepeats: 3 },
  /*
   * DENKEN picks a level per stage by the task's difficulty, to spend tokens where they matter.
   * "standard" keeps the role's configured model and effort. The defaults change effort first and
   * the model second, and use only the CLIs' model aliases, which never go stale; Codex has none,
   * so its levels change effort only unless a model is configured here.
   */
  LEVELS: readonly Level[] = ["light", "standard", "heavy"],
  // Heavy stops at "high": "max" tends to overthink. Which values a model accepts depends on it.
  EFFORTS: Readonly<Record<Provider, readonly string[]>> = {
    claude: ["low", "medium", "high", "xhigh", "max"],
    codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  /*
   * FLAMME's seeds pay off where forks share the seed's cached prefix. Claude's cache is keyed by
   * content, so a fork reads the seed from it; Codex keys its cache by session, so a fork re-reads
   * the whole seed uncached, and seeding costs more than it saves.
   */
  DEFAULT_SEEDS: SeedSwitches = { claude: true, codex: false },
  DEFAULT_LEVELS: LevelTable = {
    claude: { heavy: { effort: "high", model: "opus" }, light: { effort: "low", model: "sonnet" } },
    codex: { heavy: { effort: "high", model: "" }, light: { effort: "low", model: "" } },
  },
  isProvider = (value: string): value is Provider => value === "claude" || value === "codex",
  isLevel = (value: string): value is Level => value === "light" || value === "standard" || value === "heavy";

export { DEFAULT_LEVELS, DEFAULT_LIMITS, DEFAULT_SEEDS, EFFORTS, isLevel, isProvider, LEVELS, SUPPORTED };
