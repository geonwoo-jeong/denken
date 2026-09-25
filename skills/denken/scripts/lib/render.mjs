// Markdown for the record's step files.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stageChanges } from "./changes.mjs";
import { ARTIFACTS, TODO_DEV, TODO_FIX } from "./core.mjs";
import { readRunFile } from "./state.mjs";

export function renderFindings(title, review, { word = null, note = null } = {}) {
  const blocking = review.findings.filter((f) => f.severity === "blocking");
  const nonblocking = review.findings.filter((f) => f.severity === "nonblocking");
  const item = (f, i) => `${i + 1}. [${f.topic}]${f.file ? ` ${f.file}${f.line_start ? `:${f.line_start}` : ""}` : ""}${f.request_item ? ` (${f.request_item})` : ""}${f.todo ? ` (${f.todo})` : ""}: ${f.problem}\n   Required change: ${f.required_change}`;
  return [
    `# ${title}`,
    "",
    `Verdict: **${word ?? (blocking.length ? "REJECTED" : "APPROVED")}**${note ? ` (${note})` : ""}`,
    "",
    ...(review.summary ? [`> ${String(review.summary).trim().replace(/\n/g, "\n> ")}`, ""] : []),
    "## Blocking findings",
    "",
    blocking.map(item).join("\n") || "None.",
    "",
    "## Nonblocking findings",
    "",
    nonblocking.map(item).join("\n") || "None.",
    "",
    "## What was checked (the basis for the verdict)",
    "",
    (review.checked ?? []).map((c) => `- ${c}`).join("\n") || "- (not stated)",
    "",
  ].join("\n");
}

export function renderFacts(facts) {
  if (!facts) return "";
  const rows = [
    ["Provider", `${facts.provider}${facts.model ? ` · ${facts.model}` : ""}${facts.effort ? ` · effort ${facts.effort}` : ""}`],
    ["CLI", facts.cliVersion],
    ["Session", facts.sessionId],
    ["Exit", facts.exitCode],
    ["Duration", facts.durationSec != null ? `${facts.durationSec}s` : null],
    ["Cost", facts.costUsd != null ? `$${facts.costUsd.toFixed(4)}` : null],
    ["Level", facts.level],
    ["Seed", facts.seed],
    ["Session", facts.continued],
    ["Model that ran", facts.modelRan],
    ["Tokens", facts.tokens ? `in ${facts.tokens.input ?? "?"} · out ${facts.tokens.output ?? "?"} · cache read ${facts.tokens.cacheRead ?? "?"}${facts.tokens.cacheWrite != null ? ` · cache write ${facts.tokens.cacheWrite}` : ""}` : null],
    ["HEAD", facts.head],
    ["Stage base", facts.stageBase],
    ["Grants", facts.grants ? JSON.stringify(facts.grants) : null],
  ].filter(([, v]) => v != null && v !== "");
  return `\n## Call facts\n\n${rows.map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n`;
}

export const factsBrief = (facts) => (facts ? ` (${[facts.durationSec != null && `${facts.durationSec}s`, facts.costUsd != null && `$${facts.costUsd.toFixed(2)}`].filter(Boolean).join(", ") || facts.provider})` : "");

export function renderWork(runDir, state, call, provider, facts) {
  const parts = [`# ${call.role.toUpperCase()} · ${call.stage} round ${call.round}${call.attempt > 1 ? `, attempt ${call.attempt}` : ""} · ${provider}`, "", "## Final message", "", readRunFile(runDir, `calls/${call.id}.out.md`).trim() || "(none)"];
  for (const f of ARTIFACTS[call.stage]) parts.push("", `## ${f}`, "", readRunFile(runDir, f).trim() || "(empty)");
  if (call.stage === "dev") {
    parts.push("", "## todo-dev.md (as ticked, with evidence)", "", readRunFile(runDir, TODO_DEV).trim());
    if (existsSync(join(runDir, TODO_FIX))) parts.push("", "## todo-fix.md", "", readRunFile(runDir, TODO_FIX).trim());
    const ticks = readRunFile(runDir, `calls/${call.id}.ticks.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    parts.push("", "## Items ticked in this round", "", ticks.map((t) => `- ${t.item}: \`${t.command}\` exit 0 (${t.lastLine || "no output"})\n  Evidence: ${t.evidence}`).join("\n") || "None.");
    parts.push("", "## Files changed since development began", "", stageChanges(state, "dev").changed.map((f) => `- ${f}`).join("\n") || "None.");
  }
  if (call.stage === "wiki") parts.push("", "## Docs changed in this stage", "", stageChanges(state, "wiki").changed.map((f) => `- ${f}`).join("\n") || "None.");
  return `${parts.join("\n")}\n${renderFacts(facts)}`;
}
