/*
 * Tokens per role over the run's calls, and how much of the input came from the cache: the way to
 * see whether a level or a prompt change saved anything. FLAMME's seeds count as their own role.
 */
import type { Facts, Meta } from "./types-call.ts";
import { NONE, mapAsync, sum, unique } from "./lists.ts";
import { NO_FACTS, hasTokens } from "./call-zero.ts";
import type { CallRecord } from "./types-items.ts";
import type { RunStore } from "./types-store.ts";
import { callBase } from "./paths.ts";
import { readMetaFile } from "./meta.ts";

interface RoleFacts {
  readonly facts: Facts;
  readonly role: string;
}

interface RoleTokens {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly calls: number;
  readonly costUsd: number;
  readonly fromCache: string;
  readonly input: number;
  readonly output: number;
}

const PERCENT = 100,
  COST_SCALE = 10_000,
  ROLE_PART = 1,
  counted = (value: number): number => Math.max(NONE, value),
  seedFactsOf = (meta: Meta): Facts => {
    if (meta.seed.kind === "seed") {
      return meta.seed.facts;
    }
    return NO_FACTS;
  },
  factsOfCall =
    (runDir: string) =>
    async (call: CallRecord): Promise<readonly RoleFacts[]> => {
      const { found, meta } = await readMetaFile(`${callBase(runDir, call.id)}.meta.json`),
        role = call.id.split("-").at(ROLE_PART) ?? "",
        entries: readonly RoleFacts[] = [
          { facts: seedFactsOf(meta), role: "flamme" },
          { facts: meta.facts, role },
        ];
      if (!found) {
        return [];
      }
      return entries.filter((entry) => hasTokens(entry.facts.tokens));
    },
  fromCacheOf = (cached: number, read: number): string => {
    if (read > NONE) {
      return `${Math.round((cached / read) * PERCENT)}%`;
    }
    return "";
  },
  totalOf = (entries: readonly RoleFacts[]): RoleTokens => {
    const input = sum(entries.map((entry) => counted(entry.facts.tokens.input))),
      cacheRead = sum(entries.map((entry) => counted(entry.facts.tokens.cacheRead))),
      cacheWrite = sum(entries.map((entry) => counted(entry.facts.tokens.cacheWrite))),
      costUsd = sum(entries.map((entry) => counted(entry.facts.costUsd)));
    return {
      cacheRead,
      cacheWrite,
      calls: entries.length,
      costUsd: Math.round(costUsd * COST_SCALE) / COST_SCALE,
      fromCache: fromCacheOf(cacheRead, input + cacheRead + cacheWrite),
      input,
      output: sum(entries.map((entry) => counted(entry.facts.tokens.output))),
    };
  },
  tokenReport = async (store: RunStore): Promise<Readonly<Record<string, RoleTokens>>> => {
    const perCall = await mapAsync(store.current().calls, factsOfCall(store.dir)),
      entries = perCall.flat();
    return Object.fromEntries(unique(entries.map((entry) => entry.role)).map((role) => [role, totalOf(entries.filter((entry) => entry.role === role))]));
  };

export { tokenReport };
