// The error the engine stops with: it carries the action the engine prints for DENKEN.

class EngineError extends Error {
  public readonly action: Readonly<Record<string, unknown>>;

  public constructor(message: string, action: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "EngineError";
    this.action = action;
  }
}

export { EngineError };
