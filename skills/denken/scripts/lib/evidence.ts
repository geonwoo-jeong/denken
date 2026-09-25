/*
 * Evidence of what a call changed, kept under calls/<id>.tampered. It is captured in memory while the
 * guard repairs, and written only once every repair is done, so no write goes through a folder the
 * call pointed elsewhere. The .tampered folder's name is the engine's alone: whatever a call planted
 * there is removed first. Evidence that cannot be kept is reported, never a reason to stop.
 */
import { hasItems, mapAsync } from "./lists.ts";
import { isFile, readBinaryOr, removePath, sizeOf, writeBinary } from "./files.ts";
import { linkTarget, listPaths } from "./files-tree.ts";
import type { Evidence } from "./types-work.ts";
import { messageOf } from "./text.ts";
import path from "node:path";
import { pathErrorOr } from "./fs-slot.ts";

/*
 * Evidence is held in memory until the repairs are done, so it is capped: 16 MiB for one file, and
 * 64 MiB for everything one engine process keeps. Past the cap, only the size is kept.
 */
const MAX_BYTES = 16_777_216,
  TOTAL_BYTES = 67_108_864,
  budget = { left: TOTAL_BYTES },
  OUTSIDE = /^(?:\.\.\/)+/u,
  // Where a path's evidence goes: a path outside the project is kept under outside/.
  evidencePath = (rel: string): string => rel.replace(OUTSIDE, "outside/"),
  tooLarge = (rel: string, size: number): Evidence => ({ content: `${size} bytes, too large to keep\n`, path: `${evidencePath(rel)}.too-large` }),
  // Whether this much more may be held; if so, it is counted.
  fits = (size: number): boolean => {
    if (size > MAX_BYTES || size > budget.left) {
      return false;
    }
    budget.left -= size;
    return true;
  },
  fileEvidence = async (file: string, rel: string): Promise<Evidence> => {
    const size = await sizeOf(file);
    if (!fits(size)) {
      return tooLarge(rel, size);
    }
    return { content: await readBinaryOr(file, ""), path: evidencePath(rel) };
  },
  folderEvidence = async (file: string, rel: string): Promise<readonly Evidence[]> => {
    const inside = await listPaths(file),
      listing = `${inside.map((entry) => path.relative(file, entry)).join("\n")}\n`;
    if (!hasItems(inside)) {
      return [];
    }
    if (!fits(listing.length)) {
      return [tooLarge(`${rel}.listing`, listing.length)];
    }
    return [{ content: listing, path: `${evidencePath(rel)}.listing` }];
  },
  // What is at a path now: a symlink as where it points, a file as its content, a folder as what is in it.
  captureEvidence = async (file: string, rel: string): Promise<readonly Evidence[]> => {
    const link = await linkTarget(file);
    if (link) {
      return [{ content: `${link}\n`, path: `${evidencePath(rel)}.symlink` }];
    }
    if (await isFile(file)) {
      return [await fileEvidence(file, rel)];
    }
    return folderEvidence(file, rel);
  },
  keepOne = async (dir: string, entry: Evidence): Promise<readonly string[]> => {
    const target = path.join(dir, entry.path);
    if (!target.startsWith(`${dir}${path.sep}`)) {
      return [`evidence not kept for ${entry.path}: it would land outside the call's folder`];
    }
    try {
      await writeBinary(target, entry.content);
      return [];
    } catch (error) {
      return pathErrorOr(error, [`evidence not kept for ${entry.path}: ${messageOf(error)}`]);
    }
  },
  keepAll = async (dir: string, evidence: readonly Evidence[]): Promise<readonly string[]> => {
    if ((await linkTarget(dir)) || (await isFile(dir))) {
      await removePath(dir);
    }
    const lines = await mapAsync(evidence, async (entry) => {
      const kept = await keepOne(dir, entry);
      return kept;
    });
    return lines.flat();
  },
  // Writes the evidence; returns a line for each piece that could not be kept.
  keepEvidence = async (runDir: string, callId: string, evidence: readonly Evidence[]): Promise<readonly string[]> => {
    if (!callId || !hasItems(evidence)) {
      return [];
    }
    try {
      return await keepAll(path.join(runDir, "calls", `${callId}.tampered`), evidence);
    } catch (error) {
      return pathErrorOr(error, [`evidence not kept: ${messageOf(error)}`]);
    }
  };

export { captureEvidence, keepEvidence };
