// Options and results of the programs the engine runs: git and other child processes.
interface ProcessOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly timeoutMs?: number;
}

/*
 * A program's result. bytes is stdout read as latin1 (one character per byte), for output that is
 * not text, such as a binary patch. status is NO_STATUS when the program did not exit on its own.
 */
interface ProcessResult {
  readonly bytes: string;
  readonly missing: boolean;
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface GitOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
}

// A git command's result: out is stdout as latin1 (binary safe), text is stdout as trimmed text.
interface GitResult {
  readonly err: string;
  readonly ok: boolean;
  readonly out: string;
  readonly text: string;
}

export type { GitOptions, GitResult, ProcessOptions, ProcessResult };
