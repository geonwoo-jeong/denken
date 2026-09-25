// A call as its job describes it: its files, its prompts, its command-line context, and the facts known before it runs.
import type { CallContext, CliContext } from "./types-partb.ts";
import type { Facts, Job } from "./types-call.ts";
import { ROOT, SKILL_DIR, callBase } from "./paths.ts";
import { readText, readTextOr } from "./files.ts";
import { NO_FACTS } from "./call-zero.ts";
import { gitText } from "./git.ts";
import path from "node:path";
import { readJob } from "./job.ts";
import { runProcess } from "./processes.ts";
import { toLine } from "./json.ts";

const VERSION_TIMEOUT_MS = 20_000,
  cliVersion = async (provider: string): Promise<string> => {
    const result = await runProcess(provider, ["--version"], { cwd: ROOT, timeoutMs: VERSION_TIMEOUT_MS }),
      [first = ""] = result.stdout.trim().split("\n");
    return first;
  },
  // Permissions DENKEN granted to this role on request widen the defaults, never a reviewer's.
  grantsText = (job: Job): string => {
    if (job.agent.granted) {
      return toLine(job.agent.grants);
    }
    return "";
  },
  initialFacts = async (job: Job): Promise<Facts> => {
    const version = await cliVersion(job.agent.provider),
      head = await gitText(["rev-parse", "-q", "--verify", "HEAD"]);
    return Object.assign(structuredClone(NO_FACTS), {
      cliVersion: version,
      effort: job.agent.effort,
      grants: grantsText(job),
      head,
      level: job.agent.level,
      model: job.agent.model,
      provider: job.agent.provider,
      stageBase: job.stageBase,
    });
  },
  schemaText = async (schemaPath: string, structured: boolean): Promise<string> => {
    if (!structured) {
      return "";
    }
    const text = await readText(schemaPath);
    return text;
  },
  extensionOf = (structured: boolean): string => {
    if (structured) {
      return "json";
    }
    return "md";
  },
  cliOf = async (job: Job, base: string, system: string): Promise<CliContext> => {
    const structured = job.mode !== "work",
      schemaPath = path.join(SKILL_DIR, "schemas", `${job.mode}.schema.json`);
    return {
      base,
      effort: job.agent.effort,
      grants: job.agent.grants,
      mode: job.mode,
      model: job.agent.model,
      network: job.agent.network || job.agent.grants.network,
      outPath: `${base}.out.${extensionOf(structured)}`,
      protect: job.protect,
      provider: job.agent.provider,
      schemaPath,
      schemaText: await schemaText(schemaPath, structured),
      seeded: job.seed.kind === "seed",
      structured,
      system,
    };
  },
  /*
   * Claude gets the role as an appended system prompt, identical for every call of the role, so
   * calls share a cached prefix. Codex gets one message. A seeded call's role is in its message.
   */
  promptOf = (job: Job, system: string, fresh: string): string => {
    if (job.seed.kind === "seed" || job.agent.provider === "claude" || !system) {
      return fresh;
    }
    return `${system}\n---\n\n${fresh}`;
  },
  /*
   * A seed's forks come minutes apart (rounds, the user's confirmation): the seed's prefix is written
   * to the cache for an hour rather than the default five minutes on API billing. Only the seed and
   * its re-warm write that way; a fork's own writes keep the default, cheaper rate.
   */
  cacheEnvOf = (job: Job): Readonly<Record<string, string>> => {
    if (job.seed.kind === "seed" && job.agent.provider === "claude") {
      return { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" };
    }
    return {};
  },
  openCall = async (runDir: string, id: string): Promise<CallContext> => {
    const base = callBase(runDir, id),
      job = await readJob(base),
      system = await readTextOr(`${base}.system.md`, ""),
      message = await readText(`${base}.prompt.md`),
      fresh = await readTextOr(`${base}.prompt.fresh.md`, message),
      startedAt = Date.now();
    return {
      base,
      cacheEnv: cacheEnvOf(job),
      cli: await cliOf(job, base, system),
      facts: await initialFacts(job),
      job,
      message,
      prompt: promptOf(job, system, fresh),
      runDir,
      startedAt,
    };
  };

export { openCall };
