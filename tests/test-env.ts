// The tests' one view of their environment: the inherited variables, without git's location settings.
import { env } from "node:process";

type Pair = readonly [string, string | undefined];

/*
 * A git hook that runs these tests (pre-push does) sets GIT_DIR and friends: every git command the
 * tests start would then act on the repository being pushed instead of a test's own.
 */
const pairs: readonly Pair[] = Object.entries(env),
  inherited = (): Readonly<Record<string, string>> =>
    Object.fromEntries(
      pairs.flatMap(([key, value]): (readonly [string, string])[] => {
        if (typeof value === "string" && !key.startsWith("GIT_")) {
          return [[key, value]];
        }
        return [];
      }),
    ),
  envText = (name: string): string => env[name] ?? "";

export { envText, inherited };
