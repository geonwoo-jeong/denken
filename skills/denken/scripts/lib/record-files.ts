// Copies into the record: every file a call exchanged (raw/), and the request as it stands (00-request/).
import { REQUEST, UNITS } from "./paths.ts";
import { copyInto, exists, isFile, listNames, makeDir } from "./files.ts";
import { logDir, logPart } from "./record-log.ts";
import type { RunStore } from "./types-store.ts";
import { increment } from "./lists.ts";
import { listFiles } from "./files-tree.ts";
import { pad } from "./text.ts";
import path from "node:path";

const SEQ_WIDTH = 3,
  copyTree = async (from: string, to: string): Promise<void> => {
    const files = await listFiles(from);
    await Promise.all(
      files.map(async (file) => {
        await copyInto(file, path.join(to, path.relative(from, file)));
      }),
    );
  },
  // A call's file: copied as is; its .tampered folder (what a call wrote where it may not) with everything in it.
  copyCallFile = async (from: string, to: string): Promise<void> => {
    if (await isFile(from)) {
      await copyInto(from, to);
    } else if (from.endsWith(".tampered")) {
      await copyTree(from, to);
    }
  },
  // Copies everything a call exchanged (prompt, job, streamed log, output, gaps, ticks, ...) to raw/.
  copyRaw = async (store: RunStore, dir: string, callId: string): Promise<void> => {
    const state = store.apply({ rawSeq: increment(store.current().rawSeq) }),
      raw = path.join(dir, logPart(state, "raw")),
      names = await listNames(path.join(store.dir, "calls"));
    await makeDir(raw);
    await Promise.all(
      names
        .filter((name) => name.startsWith(`${callId}.`))
        .map(async (name) => {
          await copyCallFile(path.join(store.dir, "calls", name), path.join(raw, `${pad(state.rawSeq, SEQ_WIDTH)}_${name}`));
        }),
    );
  },
  logRaw = async (store: RunStore, callId: string): Promise<void> => {
    const dir = logDir(store.current());
    if (dir) {
      await copyRaw(store, dir, callId);
    }
  },
  copyIfThere = async (from: string, to: string): Promise<void> => {
    if (await exists(from)) {
      await copyInto(from, to);
    }
  },
  // 00-request/request.md is DENKEN's request.md as it stands; the conversation it came from is kept verbatim in raw/.
  logRequest = async (store: RunStore): Promise<void> => {
    const state = store.current(),
      dir = logDir(state);
    if (!dir) {
      return;
    }
    await copyInto(path.join(store.dir, REQUEST), path.join(dir, logPart(state, "00-request"), "request.md"));
    if (!state.unit) {
      await copyIfThere(path.join(store.dir, UNITS), path.join(dir, "00-request", UNITS));
    }
    await copyIfThere(path.join(store.dir, "conversation.md"), path.join(dir, "raw", "000_conversation.md"));
  };

export { copyTree, logRaw, logRequest };
