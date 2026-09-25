// A worker's round in the record: its step file, its READY verdict, and its timeline line.
import { STAGE_NAME, verdict } from "./record-verdicts.ts";
import { logStep, timeline } from "./record-log.ts";
import type { ActiveCall } from "./types-items.ts";
import type { Meta } from "./types-call.ts";
import type { RunStore } from "./types-store.ts";
import { callBase } from "./paths.ts";
import { factsBrief } from "./render-facts.ts";
import { oneLine } from "./text.ts";
import { readTextOr } from "./files.ts";
import { renderWork } from "./render-work.ts";

const SUMMARY_MAX = 160,
  roundLabel = (store: RunStore, call: ActiveCall): string => {
    if (call.stage === "dev" && store.current().devInput === "qa") {
      return `${STAGE_NAME[call.stage]} (QA fix), round ${call.round}`;
    }
    return `${STAGE_NAME[call.stage]}, round ${call.round}`;
  },
  logWork = async (store: RunStore, call: ActiveCall, meta: Meta): Promise<void> => {
    const who = call.role.toUpperCase(),
      said = await readTextOr(`${callBase(store.dir, call.id)}.out.md`, ""),
      step = await logStep(store, { content: await renderWork(store, call, meta.facts), name: `${call.role}-round${call.round}`, stage: call.stage });
    await verdict(store, { call: call.id, file: step, label: roundLabel(store, call), text: said, who: `${who} (${call.provider})`, word: "READY" });
    await timeline(store, who, `finished ${call.stage} round ${call.round}${factsBrief(meta.facts)}: ${oneLine(said, SUMMARY_MAX)} → ${step}`);
  };

export { logWork };
