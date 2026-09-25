// The configuration once the providers are known: limits, seeds, levels, each role's agent and the checks on them.
import { allowSameOf, limitsOf, roleSpecsOf, seedsOf } from "./config-merge.ts";
import { holeWarnings, sameWarnings, separationOf } from "./config-checks.ts";
import type { ConfigResult } from "./types-config.ts";
import type { ResolveBase } from "./types-partc.ts";
import { levelsOf } from "./config-levels.ts";
import { pickStages } from "./config-pick.ts";

const ONE_PROVIDER = 1,
  resolveAgents = async (root: string, base: ResolveBase): Promise<ConfigResult> => {
    const limits = limitsOf(base.layers),
      seeds = seedsOf(base.layers),
      levels = levelsOf(base.layers),
      picked = pickStages({ allowed: base.allowed, status: base.status, usable: base.usable }, roleSpecsOf(base.layers)),
      crossProvider = base.usable.length > ONE_PROVIDER,
      separation = separationOf(picked.stages, crossProvider),
      allowSameReviewer = allowSameOf(base.layers),
      holes = await holeWarnings(root, picked.stages);
    return {
      allowSameReviewer,
      crossProvider,
      errors: [...base.providerErrors, ...limits.errors, ...seeds.errors, ...levels.errors, ...picked.errors, ...separation.errors],
      levels: levels.value,
      limits: limits.value,
      resolved: true,
      sameReviewer: separation.sameReviewer,
      seeds: seeds.value,
      sources: base.sources,
      stages: picked.stages,
      status: base.status,
      usable: base.usable,
      warnings: [...picked.warnings, ...holes, ...sameWarnings(separation.sameReviewer, allowSameReviewer)],
    };
  };

export { resolveAgents };
