// The shapes the tests handle: the engine's JSON, the result of a command, and a test project.
type JsonValue = boolean | JsonObject | number | string | null | readonly JsonValue[];

interface JsonObject {
  readonly [key: string]: JsonValue;
}

// A command's result: its exit status, output, and stdout parsed as JSON (MISSING when it is not JSON).
interface Ran {
  readonly json: JsonValue | symbol;
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

// How drive runs the loop: it confirms the TODO lists on the user's behalf unless told not to.
interface DriveOptions {
  readonly autoConfirm?: boolean;
}

// Where a test's files are: its folder, the fake CLIs, the project, the scenario, and the environment.
interface Place {
  readonly bin: string;
  readonly dir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly proj: string;
  readonly scenarioPath: string;
}

// A test project with fake claude and codex CLIs on PATH, and one DENKEN run in it.
interface TestRun {
  readonly argsOf: (key: string, attempt?: number) => Promise<readonly string[]>;
  readonly calls: () => Promise<readonly string[]>;
  readonly callsFull: () => Promise<readonly string[]>;
  readonly denken: (...args: readonly string[]) => Promise<Ran>;
  readonly dir: string;
  readonly drive: (options?: DriveOptions) => Promise<JsonValue | symbol>;
  readonly env: Readonly<Record<string, string>>;
  readonly node: (script: string, ...args: readonly string[]) => Promise<Ran>;
  readonly proj: string;
  readonly run: string;
  readonly scenarioPath: string;
  readonly sh: (command: string, ...args: readonly string[]) => Promise<Ran>;
  readonly split: (units: string) => Promise<void>;
  readonly state: () => Promise<JsonValue | symbol>;
  readonly worktrees: () => Promise<number>;
}

export type { DriveOptions, JsonObject, JsonValue, Place, Ran, TestRun };
