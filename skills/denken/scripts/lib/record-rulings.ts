// The run's rulings.md: every ruling and permission decision, appended in order.
import { appendText, exists } from "./files.ts";
import { RULINGS } from "./paths.ts";
import path from "node:path";

const HEADER = "# Rulings\n\n",
  // A ruling's entry, with the file's header before the first one.
  appendRuling = async (runDir: string, entry: string, first: boolean): Promise<void> => {
    if (first) {
      await appendText(path.join(runDir, RULINGS), HEADER);
    }
    await appendText(path.join(runDir, RULINGS), entry);
  },
  // A decision's entry, with the header when the file does not exist yet.
  appendDecision = async (runDir: string, entry: string): Promise<void> => {
    await appendRuling(runDir, entry, !(await exists(path.join(runDir, RULINGS))));
  };

export { appendDecision, appendRuling };
