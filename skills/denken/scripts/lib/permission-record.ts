// A permission decision in the record: a step file, the timeline, verdicts.md and rulings.md.
import { framed, oneLine } from "./text.ts";
import { logStep, timeline } from "./record-log.ts";
import type { Decision } from "./types-permission.ts";
import type { RunStore } from "./types-store.ts";
import { appendDecision } from "./record-rulings.ts";
import { verdict } from "./record-verdicts.ts";

const NOTE_MAX = 140,
  SAID_MAX = 80,
  granting = (decision: Decision): boolean => decision.decision === "grant",
  outcomeText = (decision: Decision): string => {
    if (granting(decision)) {
      return `Granted: ${decision.what}`;
    }
    return "Denied";
  },
  actText = (decision: Decision): string => {
    if (granting(decision)) {
      return `granted ${decision.what} to`;
    }
    return `denied ${decision.what} for`;
  },
  entryText = (decision: Decision): string => {
    if (granting(decision)) {
      return `granted ${decision.what}`;
    }
    return `denied ${decision.what}`;
  },
  wordOf = (decision: Decision): string => {
    if (granting(decision)) {
      return "GRANTED";
    }
    return "DENIED";
  },
  recordDecision = async (store: RunStore, decision: Decision): Promise<void> => {
    const { call, id, note, userSaid } = decision,
      who = call.role.toUpperCase(),
      requests = store.current().blocked.info.requests ?? [],
      asked = requests.map((request) => `${request.need} (${request.why})`).join("; ") || "permission denials",
      file = await logStep(store, {
        content: `# DENKEN · permission ${id} · ${decision.decision} · ${who}\n\nAsked for: ${asked}\n\n${outcomeText(decision)}\n\n${note}\n${framed('\nThe user said: "', userSaid, '"\n')}`,
        name: `denken-permission-${id}-${decision.decision}`,
        stage: call.stage,
      });
    await timeline(store, "DENKEN", `${actText(decision)} ${who}: ${oneLine(note, NOTE_MAX)}${framed(' (the user: "', oneLine(userSaid, SAID_MAX), '")')} → ${file}`);
    await timeline(store, "RESUME", `${call.id} runs again`);
    await verdict(store, { call: call.id, file, label: `Permission ${id} for ${who}`, text: `${decision.what}: ${note}`, who: "DENKEN", word: wordOf(decision) });
    await appendDecision(store.dir, `## ${id} · permission · ${who} · ${entryText(decision)}\n\n${note}\n\n`);
  };

export { recordDecision };
