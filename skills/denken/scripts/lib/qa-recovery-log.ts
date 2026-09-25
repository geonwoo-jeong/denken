// A QA cycle's recovery items, appended to todo-fix.md and recorded as a step, a verdict and a timeline line.
import { appendText, exists } from "./files.ts";
import { logStep, timeline } from "./record-log.ts";
import type { Recovery } from "./types-qa.ts";
import type { RunStore } from "./types-store.ts";
import { TODO_FIX } from "./paths.ts";
import path from "node:path";
import { verdict } from "./record-verdicts.ts";

const HEADER = "# Recovery TODO\n\nWritten by the engine from failed QA checks. Fix the cause of each item in general, then tick it off with the tick command and its evidence.\n",
  appendRecovery = async (runDir: string, recovery: Recovery): Promise<void> => {
    const file = path.join(runDir, TODO_FIX);
    if (!(await exists(file))) {
      await appendText(file, HEADER);
    }
    await appendText(file, `\n## QA cycle ${recovery.cycle}\n\n${recovery.lines.join("\n")}\n`);
  },
  logRecovery = async (store: RunStore, recovery: Recovery): Promise<void> => {
    const { cycle, keys, lines } = recovery,
      step = await logStep(store, {
        content: `# Recovery TODO · QA cycle ${cycle}\n\nWritten by the engine from GENAU's failed checks; STARK fixes these, UBEL approves, then QA runs again.\n\n${lines.join("\n")}\n`,
        name: `engine-recovery-todo-qa${cycle}`,
        stage: "dev",
      });
    await verdict(store, { file: step, label: `Recovery, QA cycle ${cycle}`, text: `${keys.join(", ")} written from the failed checks, back to STARK`, who: "ENGINE", word: "RETURNED" });
    await timeline(store, "ENGINE", `recovery TODO ${keys.join(", ")} written from the QA failures → back to STARK → ${step}`);
  };

export { appendRecovery, logRecovery };
