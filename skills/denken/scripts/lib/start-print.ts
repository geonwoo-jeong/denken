// What start prints: the run, its roles, stages and limits, and its units if it is split.
import type { ConfigResult } from "./types-config.ts";
import { ROOT } from "./paths.ts";
import type { RunStore } from "./types-store.ts";
import path from "node:path";
import { print } from "./output.ts";
import { roleAgents } from "./levels.ts";

const printStarted = (store: RunStore, config: ConfigResult): void => {
  const state = store.current();
  print({
    action: "started",
    crossProvider: config.crossProvider,
    limits: config.limits,
    log: state.log,
    next: "Run next with --wait.",
    roles: roleAgents(state),
    run: path.relative(ROOT, store.dir),
    stages: config.stages,
    units: state.units.map((unit) => ({ levels: unit.levels, reqs: unit.reqs, scope: unit.scope, unit: unit.id, worktree: unit.root })),
    warnings: config.warnings,
  });
};

export { printStarted };
