// The engine's one view of its environment: every setting it takes from it is read here.
import { env } from "node:process";

type Pair = readonly [string, string | undefined];

const pairs: readonly Pair[] = Object.entries(env),
  envText = (name: string): string => env[name] ?? "",
  // The environment as plain text values, for child processes.
  environment = (): Readonly<Record<string, string>> =>
    Object.fromEntries(
      pairs.flatMap(([key, value]): (readonly [string, string])[] => {
        if (typeof value === "string") {
          return [[key, value]];
        }
        return [];
      }),
    );

export { environment, envText };
