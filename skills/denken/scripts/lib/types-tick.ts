// The tick command's arguments: the item, its evidence (or why it needs no change), and the test command to run.
interface TickArgs {
  readonly argv: readonly string[];
  readonly evidence: string;
  readonly item: string;
  readonly noChange: string;
}

// The test command's run, as the tick's log records it.
interface TestRun {
  readonly lastLine: string;
  readonly log: string;
  readonly passed: boolean;
  readonly status: number;
}

// A passed tick, ready for the ledger: its arguments, when it ran, the files it cites, its log and its run.
interface PassedTick {
  readonly args: TickArgs;
  readonly at: string;
  readonly cited: readonly string[];
  readonly log: string;
  readonly run: TestRun;
  readonly since: string;
}

export type { PassedTick, TestRun, TickArgs };
