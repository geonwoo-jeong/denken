// What a call reads, writes and is told, for each kind of call, with what every call shares.
import { REQUEST, RULINGS, SCRIPT, TODO_QA, callBase } from "./paths.ts";
import { hasItems, onlyIf } from "./lists.ts";
import type { Call } from "./types-items.ts";
import type { CallParts } from "./types-calls.ts";
import type { RunStore } from "./types-store.ts";
import { exists } from "./files.ts";
import path from "node:path";
import { reviewParts } from "./call-parts-review.ts";
import { workParts } from "./call-parts-work.ts";

const qaParts = (store: RunStore, call: Call): CallParts => {
    const { units } = store.current();
    return {
      extra: [
        ...onlyIf(hasItems(units), [
          `This is the check after the merge: ${units.map((unit) => unit.id).join(", ")} were built in parallel, each verified on its own, then merged. Run every item against the merged product, starting with QA-001, the whole test suite.`,
        ]),
        `Save the evidence for each item as files in ${callBase(store.dir, call.id)}.evidence/ (command output, logs, and screenshots when there is a UI), and list each item's files in evidence_files.`,
      ],
      read: [path.join(store.dir, REQUEST), path.join(store.dir, TODO_QA)],
      write: [],
    };
  },
  modeParts = async (store: RunStore, call: Call): Promise<CallParts> => {
    if (call.mode === "work") {
      const parts = await workParts(store, call);
      return parts;
    }
    if (call.mode === "review") {
      const parts = await reviewParts(store, call);
      return parts;
    }
    return qaParts(store, call);
  },
  permissionNote = (runDir: string): string =>
    `If a missing permission stops you (network access, a path outside the project, a blocked command), do not work around it. Ask for it with: node "${SCRIPT}" request-permission "${runDir}" --need "<network | dir:<path> | tool:<pattern> | anything else>" --why "<what it is for>". Then stop and end your turn with a one-line summary; DENKEN decides and runs you again.`,
  // Every call reads DENKEN's rulings; workers and GENAU are told how to ask for a permission.
  callParts = async (store: RunStore, call: Call): Promise<CallParts> => {
    const parts = await modeParts(store, call),
      rulings = path.join(store.dir, RULINGS);
    return {
      extra: [...parts.extra, ...onlyIf(call.mode !== "review", [permissionNote(store.dir)])],
      read: [...parts.read, ...onlyIf(await exists(rulings), [rulings])],
      write: parts.write,
    };
  };

export { callParts };
