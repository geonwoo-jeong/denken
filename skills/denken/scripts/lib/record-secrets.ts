// Likely secrets in the record, reported by file, line and kind (never the value itself).
import { readTextOr, sizeOf } from "./files.ts";
import { ROOT } from "./paths.ts";
import type { RunState } from "./types-run.ts";
import type { SecretHit } from "./types-progress.ts";
import { listFiles } from "./files-tree.ts";
import { logDir } from "./record-log.ts";
import { mapAsync } from "./lists.ts";
import path from "node:path";

interface SecretPattern {
  readonly kind: string;
  readonly pattern: Readonly<RegExp>;
}

const SCAN_MAX_BYTES = 20_971_520,
  LINE_BASE = 1,
  SECRET_PATTERNS: readonly SecretPattern[] = [
    { kind: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u },
    { kind: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
    { kind: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u },
    { kind: "Anthropic key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/u },
    { kind: "OpenAI-style key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/u },
    { kind: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/u },
    { kind: "credential assignment", pattern: /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}/iu },
  ],
  small = async (file: string): Promise<boolean> => {
    try {
      const size = await sizeOf(file);
      return size <= SCAN_MAX_BYTES;
    } catch {
      return false;
    }
  },
  lineHits = (file: string, line: string, index: number): readonly SecretHit[] =>
    SECRET_PATTERNS.filter((secret) => secret.pattern.test(line)).map((secret) => ({ file, kind: secret.kind, line: index + LINE_BASE })),
  scanFile = async (file: string): Promise<readonly SecretHit[]> => {
    if (!(await small(file))) {
      return [];
    }
    const text = await readTextOr(file, ""),
      shown = path.relative(ROOT, file);
    return text.split("\n").flatMap((line, index) => lineHits(shown, line, index));
  },
  // A run without a record (no log directory) has nothing to scan: listing "" finds no files.
  scanSecrets = async (state: RunState): Promise<readonly SecretHit[]> => {
    const files = await listFiles(logDir(state)),
      hits = await mapAsync(files, scanFile);
    return hits.flat();
  };

export { scanSecrets };
