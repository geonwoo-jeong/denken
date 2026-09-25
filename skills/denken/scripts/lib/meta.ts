/*
 * A call's result file (meta.json): read tolerantly, since an older attempt or a failed runner may
 * have written only part of it, and written atomically, since its appearance tells `next` the call
 * is over and `next` must never read a half-written one.
 */
import type { ContinueMeta, Facts, Meta, NoPlan, SeedMeta, Tokens } from "./types-call.ts";
import type { JsonObject, JsonValue } from "./types-json.ts";
import { NO_FACTS, UNKNOWN } from "./call-zero.ts";
import { asRecord, flagOf, isRecord, numberOf, parseJson, recordOf, recordsOf, stringsOf, textOf, toJson } from "./json.ts";
import { exists, readTextOr, writeText } from "./files.ts";
import type { Denial } from "./types-items.ts";
import type { MetaRead } from "./types-partb.ts";
import { now } from "./text.ts";

const NO_PLAN: NoPlan = { kind: "none" },
  tokensOf = (record: JsonObject): Tokens => ({
    cacheRead: numberOf(record, "cacheRead", UNKNOWN),
    cacheWrite: numberOf(record, "cacheWrite", UNKNOWN),
    input: numberOf(record, "input", UNKNOWN),
    output: numberOf(record, "output", UNKNOWN),
  }),
  factsOf = (record: JsonObject): Facts => ({
    cliVersion: textOf(record, "cliVersion"),
    continued: textOf(record, "continued"),
    costUsd: numberOf(record, "costUsd", UNKNOWN),
    durationSec: numberOf(record, "durationSec", UNKNOWN),
    effort: textOf(record, "effort"),
    exitCode: numberOf(record, "exitCode", UNKNOWN),
    grants: textOf(record, "grants"),
    head: textOf(record, "head"),
    level: textOf(record, "level"),
    model: textOf(record, "model"),
    modelRan: textOf(record, "modelRan"),
    provider: textOf(record, "provider"),
    seed: textOf(record, "seed"),
    sessionId: textOf(record, "sessionId"),
    stageBase: textOf(record, "stageBase"),
    tokens: tokensOf(recordOf(record, "tokens")),
    turns: numberOf(record, "turns", UNKNOWN),
  }),
  denialOf = (record: JsonObject): Denial => ({ input: record["input"] ?? "", tool: textOf(record, "tool") }),
  seedOf = (value: JsonValue | undefined): NoPlan | SeedMeta => {
    if (!isRecord(value) || textOf(value, "kind") !== "seed") {
      return NO_PLAN;
    }
    return {
      created: flagOf(value, "created"),
      facts: factsOf(recordOf(value, "facts")),
      fallback: textOf(value, "fallback"),
      key: textOf(value, "key"),
      kind: "seed",
      rewarmed: flagOf(value, "rewarmed"),
      sessionId: textOf(value, "sessionId"),
    };
  },
  continuationOf = (value: JsonValue | undefined): ContinueMeta | NoPlan => {
    if (!isRecord(value) || textOf(value, "kind") !== "continue") {
      return NO_PLAN;
    }
    return { chain: numberOf(value, "chain", UNKNOWN), fallback: textOf(value, "fallback"), from: textOf(value, "from"), kind: "continue", sessionId: textOf(value, "sessionId") };
  },
  // A result as far as it was written: whatever is missing reads as its zero value.
  toMeta = (value: unknown): Meta => {
    const record = asRecord(value);
    return {
      continuation: continuationOf(record["continuation"]),
      denials: recordsOf(record, "denials").map((item) => denialOf(item)),
      error: textOf(record, "error"),
      exitCode: numberOf(record, "exitCode", UNKNOWN),
      facts: factsOf(recordOf(record, "facts")),
      finished: textOf(record, "finished"),
      nonce: textOf(record, "nonce"),
      seed: seedOf(record["seed"]),
      sessionId: textOf(record, "sessionId"),
      status: textOf(record, "status"),
      violations: stringsOf(record, "violations"),
    };
  },
  failedMeta = (nonce: string, error: string): Meta => ({
    continuation: NO_PLAN,
    denials: [],
    error,
    exitCode: UNKNOWN,
    facts: NO_FACTS,
    finished: now(),
    nonce,
    seed: NO_PLAN,
    sessionId: "",
    status: "failed",
    violations: [],
  }),
  // A result file that exists but cannot be read counts as a failed call with no nonce.
  readMetaFile = async (file: string): Promise<MetaRead> => {
    if (!(await exists(file))) {
      return { found: false, meta: toMeta({}) };
    }
    const parsed = parseJson(await readTextOr(file, ""));
    if (parsed.ok) {
      return { found: true, meta: toMeta(parsed.value) };
    }
    return { found: true, meta: failedMeta("", `the call's result file is unreadable: ${parsed.error}`) };
  },
  writeMeta = async (base: string, meta: Meta): Promise<void> => {
    await writeText(`${base}.meta.json`, toJson(meta));
  };

export { failedMeta, NO_PLAN, readMetaFile, toMeta, writeMeta };
