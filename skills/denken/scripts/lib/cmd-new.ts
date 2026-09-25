// The new command: a run's directory under .denken/runs/, its record under ai-log/, and its state in intake.
import { DENKEN_DIR, REQUEST, ROOT } from "./paths.ts";
import { createLog, timeline } from "./record-log.ts";
import { exists, hashFile, makeDir, writeText } from "./files.ts";
import { fail, print } from "./output.ts";
import { now, pad, slug } from "./text.ts";
import { makeStore } from "./store.ts";
import { newRunState } from "./state-zero.ts";
import { patch } from "./lists.ts";
import path from "node:path";

const WIDTH = 2,
  MONTH_OFFSET = 1,
  stampOf = (moment: Readonly<Date>): string =>
    `${moment.getFullYear()}${pad(moment.getMonth() + MONTH_OFFSET, WIDTH)}${pad(moment.getDate(), WIDTH)}-${pad(moment.getHours(), WIDTH)}${pad(moment.getMinutes(), WIDTH)}`,
  ensureIgnore = async (): Promise<void> => {
    const ignore = path.join(DENKEN_DIR, ".gitignore");
    if (!(await exists(ignore))) {
      await writeText(ignore, "runs/\nlocks/\nconfig.local.json\n");
    }
  },
  // The run's state in intake, with its record's verdicts.md as the engine wrote it.
  startRun = async (dir: string, name: string): Promise<string> => {
    const log = await createLog(name),
      verdictsSha = await hashFile(path.join(ROOT, log, "verdicts.md")),
      state = newRunState({ created: now(), log, task: name }),
      store = makeStore(dir, patch(state, { verdictsSha }));
    await timeline(store, "DENKEN", `run created: ${name}`);
    await store.save();
    return log;
  },
  cmdNew = async (name: string): Promise<void> => {
    const dir = path.join(DENKEN_DIR, "runs", `${stampOf(new Date())}-${slug(name)}`),
      run = path.relative(ROOT, dir);
    if (!name) {
      fail("usage: new <slug>");
    }
    if (await exists(dir)) {
      fail(`run already exists: ${run}`);
    }
    await makeDir(path.join(dir, "calls"));
    await ensureIgnore();
    print({ action: "created", log: await startRun(dir, name), next: `Record your conversation with the user in ${path.join(run, "conversation.md")}, write ${path.join(run, REQUEST)}, confirm it with the user, then run start.`, run });
  };

export { cmdNew };
