/*
 * What a call may change, seen at one moment: the project's state as one hash, ignored files, and
 * DENKEN's own files. Listings never follow a symlink: a symlink is recorded as itself (its target
 * and the content behind it), and so is every folder above one of DENKEN's files.
 */
import { DENKEN_DIR, EXCLUDE, ROOT, SKILL_DIR } from "./paths.ts";
import { entriesOf, mapAsync, unique } from "./lists.ts";
import { exists, hashFile } from "./files.ts";
import { linkTarget, listPaths } from "./files-tree.ts";
import { sha, shaBinary } from "./text.ts";
import type { Snapshot } from "./types-work.ts";
import type { Tree } from "./types-names.ts";
import { gitBinary } from "./git.ts";
import path from "node:path";
import { toLine } from "./json.ts";

type Entry = readonly [string, string];

const AGENT_DIRS: readonly string[] = [".claude", ".codex", ".agents", ".cursor", ".gemini"],
  CONFIG_FILES: readonly string[] = ["config.json", "config.local.json"],
  CONTEXT_FILE = /(?:^|\/)(?:CLAUDE|CLAUDE\.local|AGENTS)\.md$/u,
  // The record's raw exchanges and QA evidence, written by the engine alone after each call.
  RECORD_ONLY = /\/(?:raw|evidence)\//u,
  utf8Of = (bytes: string): string => Buffer.from(bytes, "latin1").toString("utf8"),
  // A git listing separated by NUL bytes (-z), as raw names (latin1) or as paths (utf8).
  rawNames = async (args: readonly string[]): Promise<readonly string[]> => {
    const bytes = await gitBinary(args);
    return bytes.split("\0").filter(Boolean);
  },
  gitNames = async (args: readonly string[]): Promise<readonly string[]> => {
    const names = await rawNames(args);
    return names.map((name) => utf8Of(name));
  },
  // A path that is there: a file, or a symlink (even one that points nowhere).
  presentPath = async (file: string): Promise<readonly string[]> => {
    if ((await linkTarget(file)) || (await exists(file))) {
      return [file];
    }
    return [];
  },
  agentConfigFiles = async (): Promise<readonly string[]> => {
    const dirs = await mapAsync(
        AGENT_DIRS.map((dir) => path.join(ROOT, dir)),
        listPaths,
      ),
      mcp = await presentPath(path.join(ROOT, ".mcp.json")),
      tracked = await gitNames(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
      skill = await listPaths(SKILL_DIR);
    return unique([...dirs.flat(), ...mcp, ...tracked.filter((file) => CONTEXT_FILE.test(file)).map((file) => path.join(ROOT, file)), ...skill]);
  },
  untrackedLine = async (name: string): Promise<string> => {
    const hash = await hashFile(path.join(ROOT, utf8Of(name)));
    return `${name}\0${hash}\n`;
  },
  // The project's tracked and untracked state, as one hash.
  projectHash = async (): Promise<string> => {
    const untracked = await rawNames(["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...EXCLUDE]),
      head = await gitBinary(["rev-parse", "-q", "--verify", "HEAD"]),
      status = await gitBinary(["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ...EXCLUDE]),
      diff = await gitBinary(["diff", "--binary", "--", ".", ...EXCLUDE]),
      staged = await gitBinary(["diff", "--cached", "--binary", "--", ".", ...EXCLUDE]),
      lines = await mapAsync(untracked, untrackedLine);
    return shaBinary([head, status, diff, staged, ...lines].join(""));
  },
  rootEntry = async (file: string): Promise<Entry> => {
    const hash = await hashFile(path.join(ROOT, file));
    return [file, hash];
  },
  // Ignored files such as .env: hash the ones that exist, skip ignored directories (caches, builds).
  ignoredHashes = async (): Promise<Tree> => {
    const names = await gitNames(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", ".", ...EXCLUDE]),
      entries = await mapAsync(
        names.filter((name) => !name.endsWith("/")),
        rootEntry,
      );
    return Object.fromEntries(entries);
  },
  recordFiles = async (logPath: string): Promise<readonly string[]> => {
    if (!logPath) {
      return [];
    }
    const root = path.join(ROOT, logPath),
      files = await listPaths(root);
    return files.filter((file) => !RECORD_ONLY.test(path.relative(root, file)));
  },
  // DENKEN's files: config, everything in the run directory except this call's own files, the record, agent configuration.
  ownedPaths = async (runDir: string, callId: string, logPath: string): Promise<readonly string[]> => {
    const config = await mapAsync(
        CONFIG_FILES.map((name) => path.join(DENKEN_DIR, name)),
        presentPath,
      ),
      runFiles = await listPaths(runDir),
      record = await recordFiles(logPath),
      agents = await agentConfigFiles();
    return [...config.flat(), ...runFiles.filter((file) => !path.relative(runDir, file).startsWith(`calls/${callId}.`)), ...record, ...agents];
  },
  // A file's mark: its content's hash, and for a symlink also where it points.
  ownedEntry = async (file: string): Promise<Entry> => {
    const link = await linkTarget(file),
      hash = await hashFile(file);
    if (link) {
      return [path.relative(ROOT, file), `symlink:${link}:${hash}`];
    }
    return [path.relative(ROOT, file), hash];
  },
  // The folders a path's symlink state is kept for: up to the project root, or the skill's folder.
  chainOf = (file: string): readonly string[] => {
    const anchor = [ROOT, SKILL_DIR].find((root) => file.startsWith(`${root}/`)) ?? path.dirname(file),
      parent = path.dirname(file);
    if (file === anchor || parent === file || !file.startsWith(`${anchor}/`)) {
      return [];
    }
    return [file, ...chainOf(parent)];
  },
  linkEntry = async (file: string): Promise<Entry> => {
    const link = await linkTarget(file);
    return [path.relative(ROOT, file), link];
  },
  snapshot = async (runDir: string, callId: string, logPath: string): Promise<Snapshot> => {
    const project = await projectHash(),
      ignored = await ignoredHashes(),
      owned = await ownedPaths(runDir, callId, logPath),
      marks = await mapAsync(owned, ownedEntry),
      links = await mapAsync(unique(owned.flatMap((file) => chainOf(file))), linkEntry);
    return { ignored, links: Object.fromEntries(links), owned: Object.fromEntries(marks), project };
  },
  /*
   * The project as the units found it: tracked, untracked and ignored files and agent
   * configuration, without DENKEN's own run and record. It must not change while units work.
   */
  projectPrint = async (runDir: string): Promise<string> => {
    const shot = await snapshot(runDir, "", ""),
      mine = `${path.relative(ROOT, runDir)}/`;
    return sha(toLine([shot.project, shot.ignored, entriesOf(shot.owned).filter(([file]) => !file.startsWith(mine))]));
  };

export { agentConfigFiles, projectPrint, snapshot };
