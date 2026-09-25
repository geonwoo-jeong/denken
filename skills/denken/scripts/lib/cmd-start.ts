// The start command: the user agreed the request; the run takes its assignment and begins planning (or its units do).
import { checkChoices, seedingOf } from "./start-choices.ts";
import { configOrStop, splitOf } from "./start-config.ts";
import type { ConfigResult } from "./types-config.ts";
import type { RunStore } from "./types-store.ts";
import type { UnitsCheck } from "./types-units.ts";
import { checkRequest } from "./start-request.ts";
import { gitText } from "./git.ts";
import { parseChoices } from "./level-choices.ts";
import { printStarted } from "./start-print.ts";
import { recordStart } from "./start-record.ts";

const assign = async (store: RunStore, config: ConfigResult, args: readonly string[]): Promise<void> => {
    const { levels, overrides } = parseChoices(args, { levels: {}, overrides: {} });
    store.apply({
      assignment: {
        allowSameReviewer: config.allowSameReviewer,
        crossProvider: config.crossProvider,
        levels: config.levels,
        limits: config.limits,
        sameReviewer: config.sameReviewer,
        stages: config.stages,
        warnings: config.warnings,
      },
      baseRef: await gitText(["rev-parse", "-q", "--verify", "HEAD"]),
      levels,
      overrides,
      seeding: seedingOf(args, config),
    });
  },
  cmdStart = async (store: RunStore, args: readonly string[]): Promise<void> => {
    await checkRequest(store);
    const config = await configOrStop(),
      split: UnitsCheck = await splitOf(store.dir);
    await assign(store, config, args);
    checkChoices(store.current(), split.units);
    await recordStart(store, split);
    await store.save();
    printStarted(store, config);
  };

export { cmdStart };
