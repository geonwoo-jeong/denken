// A reviewer's result. The stage's outcome is the engine's: the blocking findings still open after
// DENKEN's dismissals. When the reviewer's own verdict says otherwise, the record says both.
import { oneLine } from "./core.mjs";
import { identityOf, recordReview } from "./findings.mjs";
import { logStep, STAGE_NAME, timeline, verdict } from "./record.mjs";
import { factsBrief, renderFacts, renderFindings } from "./render.mjs";
import { approve } from "./stages.mjs";

export function ingestReview(runDir, state, call, meta, output, outPath) {
  const stage = call.stage;
  const who = call.role.toUpperCase();
  state.lastReview[stage] = outPath;
  const mergedReview = stage === "dev" && state.devInput === "merge";
  if (stage === "dev") state.devInput = "review";
  const dismissed = new Set(state.dismissed[stage] ?? []);
  const raised = output.findings.filter((f) => f.severity === "blocking");
  const open = raised.filter((f) => !dismissed.has(identityOf(f, state.findings[stage])));
  const word = open.length ? "REJECTED" : "APPROVED";
  const said = output.verdict === "APPROVED" ? "APPROVED" : "REJECTED";
  const note = said === word ? null : `reviewer's verdict: ${said}; ${open.length} open blocking finding(s)${raised.length > open.length ? `, ${raised.length - open.length} already dismissed by DENKEN` : ""}`;
  const file = logStep(state, stage, `${call.role}-${word.toLowerCase()}-round${call.round}`, renderFindings(`${who} · ${stage} review, round ${call.round} · ${call.provider}`, output, { word, note }) + renderFacts(meta.facts));
  timeline(state, who, `${open.length ? `REJECTED (${open.length} blocking): ${oneLine(open[0].problem, 120)}` : "APPROVED"}${note ? ` (${note})` : ""}${factsBrief(meta.facts)} → ${file}`);
  verdict(state, `${STAGE_NAME[stage]} review${mergedReview ? " of the merged units" : ""}, round ${call.round}`, `${who} (${call.provider})`, word, output.summary ?? (open.length ? open[0].problem : "no findings"), { call: call.id, file, note });
  if (recordReview(state, stage, call, output.findings) === 0) approve(state, stage, outPath);
}
