/*
 * A cap on file operations running at once. Snapshots hash hundreds of files in parallel; without a
 * cap, the process runs out of file descriptors (EMFILE), and a guard must never read that as
 * "this file is missing". A freed slot is handed to the longest waiter alone, so waiting costs the
 * same however many operations queue up.
 */
import { codeOf } from "./text.ts";

type Wake = () => void;

const LIMIT = 64,
  STEP = 1,
  // Running out of something the whole process needs: no answer about any one path.
  RESOURCE: ReadonlySet<string> = new Set(["EAGAIN", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOMEM"]),
  // Waiters are taken from the head without shifting the array; it is dropped once drained, or trimmed when long.
  TRIM_AT = 4096,
  START = 0,
  counter = { active: 0 },
  queue: { head: number; items: Wake[] } = { head: START, items: [] },
  take = async (): Promise<void> => {
    if (counter.active < LIMIT) {
      counter.active += STEP;
      return;
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    queue.items.push(() => {
      resolve(true);
    });
    await promise;
  },
  advance = (): void => {
    queue.head += STEP;
    if (queue.head === queue.items.length) {
      queue.items = [];
      queue.head = START;
    } else if (queue.head >= TRIM_AT) {
      queue.items = queue.items.slice(queue.head);
      queue.head = START;
    }
  },
  // The slot passes straight to the next waiter, or is freed when none waits.
  give = (): void => {
    const next = queue.items[queue.head];
    if (next) {
      advance();
      next();
      return;
    }
    counter.active -= STEP;
  },
  withSlot = async <Result>(work: () => Promise<Result>): Promise<Result> => {
    await take();
    try {
      return await work();
    } finally {
      give();
    }
  },
  // A file operation that takes a slot while it runs. It must not call another slotted operation: with every slot taken, the inner one would wait forever.
  slotted =
    <Args extends readonly unknown[], Result>(work: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      const result = await withSlot(async () => {
        const done = await work(...args);
        return done;
      });
      return result;
    },
  /*
   * The fallback when a path cannot be used (missing, a loop of symlinks, no permission): one bad
   * path must not stop a guard. Running out of resources, or an error that is about no path at all,
   * is thrown on.
   */
  isPathError = (error: unknown): boolean => {
    const code = codeOf(error);
    return Boolean(code) && !RESOURCE.has(code);
  },
  pathErrorOr = <Value>(error: unknown, fallback: Value): Value => {
    if (isPathError(error)) {
      return fallback;
    }
    throw error;
  };

export { isPathError, pathErrorOr, slotted, withSlot };
