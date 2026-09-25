// A call's job (job.json), written by the engine when it launches the call and read by the call's _exec process.
import { asRecord, isRecord, parseJson, textOf } from "./json.ts";
import type { Job } from "./types-call.ts";
import { fail } from "./output.ts";
import { readTextOr } from "./files.ts";

// The engine alone writes job files, so their shape markers are enough to take one as a job.
const isJob = (value: unknown): value is Job =>
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["nonce"] === "string" &&
    typeof value["mode"] === "string" &&
    typeof value["timeoutMs"] === "number" &&
    isRecord(value["agent"]) &&
    isRecord(value["guard"]) &&
    isRecord(value["seed"]) &&
    isRecord(value["continuation"]),
  toJob = (value: unknown): Job => {
    if (isJob(value)) {
      return value;
    }
    return fail("the call's job file is not a DENKEN job");
  },
  readJob = async (base: string): Promise<Job> => {
    const parsed = parseJson(await readTextOr(`${base}.job.json`, ""));
    return toJob(parsed.value);
  },
  // The job's nonce, or empty when the job cannot be read (the runner's own failure is then recorded without it).
  jobNonce = async (base: string): Promise<string> => {
    const parsed = parseJson(await readTextOr(`${base}.job.json`, ""));
    return textOf(asRecord(parsed.value), "nonce");
  };

export { jobNonce, readJob, toJob };
