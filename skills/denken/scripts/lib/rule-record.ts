// A ruling in the record: the run's rulings, a step file, the timeline, verdicts.md and rulings.md.
import type { RuleRequest, Ruled } from "./types-rule.ts";
import { STEP, appended, increment } from "./lists.ts";
import { logStep, timeline } from "./record-log.ts";
import { now, oneLine } from "./text.ts";
import type { RunStore } from "./types-store.ts";
import { appendRuling } from "./record-rulings.ts";
import { verdict } from "./record-verdicts.ts";

const NOTE_MAX = 140,
  subjectOf = (request: RuleRequest): string => {
    if (request.decision === "dismiss") {
      return request.targets.join(", ");
    }
    return request.blocked.info.identity ?? request.blocked.reason;
  },
  recordRuling = async (store: RunStore, request: RuleRequest): Promise<Ruled> => {
    const { blocked, decision, note, stage } = request,
      id = `R${increment(store.current().rulings.length)}`,
      subject = subjectOf(request),
      { rulings } = store.apply({ rulings: appended(store.current().rulings, { at: now(), decision, id, reason: blocked.reason, stage, subject }) }),
      file = await logStep(store, { content: `# DENKEN · ruling ${id} · ${decision}\n\nOn: ${subject} (${blocked.reason})\n\n${note.trim()}\n`, name: `denken-ruling-${id}-${decision}`, stage });
    await timeline(store, "DENKEN", `ruling ${id} (${decision}) on ${subject}: ${oneLine(note, NOTE_MAX)} → ${file}`);
    await verdict(store, { file, label: `Ruling ${id} on ${subject}`, text: note, who: "DENKEN", word: decision.toUpperCase() });
    await appendRuling(store.dir, `## ${id} · ${stage} · ${subject} · ${decision}\n\n${note.trim()}\n\n`, rulings.length === STEP);
    return { file, id };
  };

export { recordRuling };
