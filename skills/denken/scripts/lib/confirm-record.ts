/*
 * The user's confirmation: what exactly they confirmed (hashes, with checkbox state ignored), the
 * request ids that keep their wording from now on, and the confirmation in the record.
 */
import { TODO_DEV, TODO_QA } from "./paths.ts";
import { logStep, timeline } from "./record-log.ts";
import type { RunStore } from "./types-store.ts";
import { logRequest } from "./record-files.ts";
import { oneLine } from "./text.ts";
import { readRunFile } from "./store.ts";
import { verdict } from "./record-verdicts.ts";

const SAID_MAX = 140,
  recordConfirmed = async (store: RunStore, userSaid: string): Promise<void> => {
    await logRequest(store);
    const { hashes } = store.current().confirmed,
      todoDev = await readRunFile(store.dir, TODO_DEV),
      todoQa = await readRunFile(store.dir, TODO_QA),
      content = `# The user confirmed the scope and TODO lists\n\n> ${userSaid}\n\nConfirmed content (hashes, with checkbox state ignored):\n\n- request: ${hashes.request}\n- todoDev: ${hashes.todoDev}\n- todoQa: ${hashes.todoQa}\n\n## todo-dev.md\n\n${todoDev.trim()}\n\n## todo-qa.md\n\n${todoQa.trim()}\n`,
      file = await logStep(store, { content, name: "user-confirmed", stage: "plan" });
    await timeline(store, "USER via DENKEN", `confirmed the scope and TODO lists: "${oneLine(userSaid, SAID_MAX)}" → ${file}`);
    await verdict(store, { file, label: "Confirmation", text: userSaid, who: "USER", word: "CONFIRMED" });
    await timeline(store, "RESUME", "development starts");
  };

export { recordConfirmed };
