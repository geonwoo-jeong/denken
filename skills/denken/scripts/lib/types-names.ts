// The names a run is built from: stages, modes, roles, and the maps keyed by them.

type Stage = "dev" | "plan" | "qa" | "wiki";

type WorkStage = "dev" | "plan" | "wiki";

type RunStage = Stage | "aborted" | "done" | "intake" | "units";

type Mode = "qa" | "review" | "work";

type Role = "frieren" | "genau" | "methode" | "richter" | "serie" | "stark" | "ubel";

type DevInput = "" | "merge" | "qa" | "review";

type BlockKind = "none" | "permission" | "ruling" | "user";

type StageMap<Value> = Readonly<Record<Stage, Value>>;

type TextMap<Value> = Readonly<Record<string, Value>>;

// A file's content hash by path: what a set of files looked like at one moment.
type Tree = TextMap<string>;

export type {
  BlockKind,
  DevInput,
  Mode,
  Role,
  RunStage,
  Stage,
  StageMap,
  TextMap,
  Tree,
  WorkStage,
};
