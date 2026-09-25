// The fake's files and processes: reading with a fallback, appending, writing, and running the engine's commands.
import { access, appendFile, link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import path from "node:path";
import { spawn } from "node:child_process";

const readOr = async (file: string, fallback: string): Promise<string> => {
    try {
      const text = await readFile(file, "utf8");
      return text;
    } catch {
      return fallback;
    }
  },
  exists = async (file: string): Promise<boolean> => {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  },
  appendTo = async (file: string, text: string): Promise<void> => {
    await appendFile(file, text);
  },
  writeTo = async (file: string, text: string): Promise<void> => {
    await writeFile(file, text);
  },
  // A file written in a folder that may not exist yet.
  writeInto = async (file: string, text: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  },
  removeFile = async (file: string): Promise<void> => {
    await rm(file, { force: true });
  },
  // A path replaced by a symlink to the target, whatever was there before.
  linkInto = async (file: string, target: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await rm(file, { force: true, recursive: true });
    await symlink(target, file);
  },
  // A path replaced by a hard link to the target file.
  hardLinkInto = async (file: string, target: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await rm(file, { force: true, recursive: true });
    await link(target, file);
  },
  // Text appended to a file in a folder that may not exist yet.
  appendInto = async (file: string, text: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, text);
  },
  sleep = async (ms: number): Promise<void> => {
    await delay(ms);
  },
  // One of the engine's commands, run to its end with its output ignored, as an agent's shell would.
  runNode = async (args: readonly string[]): Promise<void> => {
    const child = spawn(process.execPath, args, { stdio: "ignore" });
    await once(child, "close");
  };

export { appendInto, appendTo, exists, hardLinkInto, linkInto, readOr, removeFile, runNode, sleep, writeInto, writeTo };
