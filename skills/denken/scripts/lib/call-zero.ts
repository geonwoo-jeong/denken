// The zero values of a call's facts and results: -1 is "not reported", empty text is "none".
import type { Facts, Tokens } from "./types-call.ts";

const UNKNOWN = -1,
  NO_TOKENS: Tokens = { cacheRead: UNKNOWN, cacheWrite: UNKNOWN, input: UNKNOWN, output: UNKNOWN },
  NO_FACTS: Facts = {
    cliVersion: "",
    continued: "",
    costUsd: UNKNOWN,
    durationSec: UNKNOWN,
    effort: "",
    exitCode: UNKNOWN,
    grants: "",
    head: "",
    level: "",
    model: "",
    modelRan: "",
    provider: "",
    seed: "",
    sessionId: "",
    stageBase: "",
    tokens: NO_TOKENS,
    turns: UNKNOWN,
  },
  isKnown = (value: number): boolean => value !== UNKNOWN,
  hasTokens = (tokens: Tokens): boolean => isKnown(tokens.input) || isKnown(tokens.output) || isKnown(tokens.cacheRead) || isKnown(tokens.cacheWrite);

export { hasTokens, isKnown, NO_FACTS, NO_TOKENS, UNKNOWN };
