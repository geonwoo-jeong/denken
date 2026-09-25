// A call's facts as the record shows them: a list under its step, and a short note in the timeline.
import type { Facts, Tokens } from "./types-call.ts";
import { hasTokens, isKnown } from "./call-zero.ts";
import { framed } from "./text.ts";

const COST_DIGITS = 4,
  BRIEF_COST_DIGITS = 2,
  known = (value: number, show: (value: number) => string): string => {
    if (isKnown(value)) {
      return show(value);
    }
    return "";
  },
  count = (value: number): string => {
    if (isKnown(value)) {
      return String(value);
    }
    return "?";
  },
  tokensText = (tokens: Tokens): string => {
    if (!hasTokens(tokens)) {
      return "";
    }
    return `in ${count(tokens.input)} · out ${count(tokens.output)} · cache read ${count(tokens.cacheRead)}${known(tokens.cacheWrite, (value) => ` · cache write ${value}`)}`;
  },
  rowsOf = (facts: Facts): readonly (readonly [string, string])[] => [
    ["Provider", `${facts.provider}${framed(" · ", facts.model, "")}${framed(" · effort ", facts.effort, "")}`],
    ["CLI", facts.cliVersion],
    ["Session", facts.sessionId],
    ["Exit", known(facts.exitCode, String)],
    ["Duration", known(facts.durationSec, (value) => `${value}s`)],
    ["Cost", known(facts.costUsd, (value) => `$${value.toFixed(COST_DIGITS)}`)],
    ["Level", facts.level],
    ["Seed", facts.seed],
    ["Session", facts.continued],
    ["Model that ran", facts.modelRan],
    ["Tokens", tokensText(facts.tokens)],
    ["HEAD", facts.head],
    ["Stage base", facts.stageBase],
    ["Grants", facts.grants],
  ],
  // Facts with no provider are none: the call wrote no facts.
  renderFacts = (facts: Facts): string => {
    if (!facts.provider) {
      return "";
    }
    const rows = rowsOf(facts).filter(([, value]) => value !== "");
    return `\n## Call facts\n\n${rows.map(([key, value]) => `- ${key}: ${value}`).join("\n")}\n`;
  },
  factsBrief = (facts: Facts): string => {
    if (!facts.provider) {
      return "";
    }
    const parts = [known(facts.durationSec, (value) => `${value}s`), known(facts.costUsd, (value) => `$${value.toFixed(BRIEF_COST_DIGITS)}`)].filter(Boolean);
    return ` (${parts.join(", ") || facts.provider})`;
  };

export { factsBrief, renderFacts };
