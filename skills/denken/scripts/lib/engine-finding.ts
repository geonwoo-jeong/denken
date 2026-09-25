// A finding of the engine's own checks, with the fields a reviewer's finding has, empty where unknown.
import type { Finding } from "./types-items.ts";
import { NONE } from "./lists.ts";

interface EngineGap {
  readonly file: string;
  readonly identity: string;
  readonly problem: string;
  readonly request_item?: string;
  readonly required_change: string;
  readonly todo?: string;
  readonly topic?: string;
}

const engineFinding = (gap: EngineGap): Finding => ({
  file: gap.file,
  identity: gap.identity,
  line_end: NONE,
  line_start: NONE,
  problem: gap.problem,
  request_item: gap.request_item ?? "",
  required_change: gap.required_change,
  severity: "blocking",
  source: "engine",
  todo: gap.todo ?? "",
  topic: gap.topic ?? gap.identity,
});

export { engineFinding };
