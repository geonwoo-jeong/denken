// A map by stage with one stage's value replaced.
import type { Stage, StageMap } from "./types-names.ts";

const withStage = <Value>(map: StageMap<Value>, stage: Stage, value: Value): StageMap<Value> => Object.assign(structuredClone(map), { [stage]: value });

export { withStage };
