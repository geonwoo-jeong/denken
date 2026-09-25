// The configuration as the config command shows it: providers, files, roles, limits, seeds and levels.
import type { Agent, ConfigResult, LevelSpec } from "./types-config.ts";
import { REVIEWER, WORKER } from "./stage-table.ts";
import { ROOT } from "./paths.ts";
import { SUPPORTED } from "./config-defaults.ts";
import { framed } from "./text.ts";
import { hasItems } from "./lists.ts";
import { resolveDetailed } from "./config-resolve.ts";
import { toJson } from "./json.ts";

const STAGE_WIDTH = 5,
  ROLE_WIDTH = 28,
  PROVIDER_WIDTH = 7,
  EXIT_OK = 0,
  EXIT_FAILURE = 1,
  networkWord = (agent: Agent): string => {
    if (agent.network) {
      return "network";
    }
    return "";
  },
  describe = (agent: Agent): string => `${agent.provider}${framed(" (", [agent.model, framed("effort ", agent.effort, ""), networkWord(agent)].filter(Boolean).join(", "), ")")}`,
  row = (stage: string, worker: string, checker: string): string => `  ${stage.padEnd(STAGE_WIDTH)} ${worker.padEnd(ROLE_WIDTH)} ${checker}`,
  levelText = (spec: LevelSpec): string => [spec.model, framed("effort ", spec.effort, "")].filter(Boolean).join(", ") || "as configured",
  pairRow = (result: ConfigResult, stage: "dev" | "plan" | "wiki"): string =>
    row(stage, `${WORKER[stage].toUpperCase()} → ${describe(result.stages[stage].worker)}`, `${REVIEWER[stage].toUpperCase()} → ${describe(result.stages[stage].reviewer)}`),
  modeOf = (result: ConfigResult): string => {
    if (result.crossProvider) {
      return "cross-provider";
    }
    return "single-provider";
  },
  resolvedLines = (result: ConfigResult): readonly string[] => {
    const { limits } = result;
    if (!result.resolved) {
      return [];
    }
    return [
      `Mode:      ${modeOf(result)}`,
      `Limits:    DENKEN steps in when a topic is raised ${limits.topicRepeats} times, the loop stalls, or a stage reaches ${limits.roundsPerStage} rounds; each call times out after ${limits.callTimeoutMin} min; at most ${limits.parallelUnits} units work at once\n`,
      row("stage", "worker", "reviewer / runner"),
      pairRow(result, "plan"),
      pairRow(result, "dev"),
      row("qa", "", `GENAU → ${describe(result.stages.qa.runner)}`),
      pairRow(result, "wiki"),
      `\nSeeds:     FLAMME keeps worker, reviewer and QA seeds that calls fork, for ${SUPPORTED.filter((provider) => result.seeds[provider]).join(" and ") || "no provider"}`,
      "\nLevels DENKEN picks per stage by difficulty (standard = each role as configured above):",
      ...SUPPORTED.map((provider) => `  ${provider.padEnd(PROVIDER_WIDTH)} light: ${levelText(result.levels[provider].light)} · heavy: ${levelText(result.levels[provider].heavy)}`),
    ];
  },
  providersLines = (result: ConfigResult, probed: boolean): readonly string[] => {
    if (!probed) {
      return [];
    }
    return [`Providers: ${SUPPORTED.map((provider) => `${provider} ${result.status[provider].problem || "ready"}`).join(", ")}`];
  },
  sourcesText = (sources: readonly string[]): string => {
    if (hasItems(sources)) {
      return sources.join(" + ");
    }
    return "defaults (no config file yet)";
  },
  exitCodeOf = (result: ConfigResult): number => {
    if (hasItems(result.errors)) {
      return EXIT_FAILURE;
    }
    return EXIT_OK;
  },
  lines = (texts: readonly string[]): string => texts.map((text) => `${text}\n`).join(""),
  // Shows the resolved configuration, as JSON or as text; errors make the command fail.
  showConfig = async (json: boolean): Promise<void> => {
    const { probed, result } = await resolveDetailed(ROOT);
    if (json) {
      process.stdout.write(`${toJson(result)}\n`);
    } else {
      process.stdout.write(lines([...providersLines(result, probed), `Config:    ${sourcesText(result.sources)}`, ...resolvedLines(result), ...result.warnings.map((warning) => `\nwarning: ${warning}`)]));
      process.stderr.write(lines(result.errors.map((error) => `\nerror: ${error}`)));
    }
    process.exitCode = exitCodeOf(result);
  };

export { showConfig };
