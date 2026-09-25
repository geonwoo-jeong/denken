/*
 * The final messages of the calls that answer in JSON or ask for something: FLAMME's seeds, a
 * permission request, the reviewers, and GENAU, who leaves an evidence file per item.
 */
import type { Final, Played } from "./fake-types.ts";
import { after, groupOf } from "./fake-text.ts";
import { at, isRecord, listAt, textAt } from "./test-json.ts";
import { readOr, runNode, writeInto } from "./fake-io.ts";
import type { JsonObject } from "./test-types.ts";
import { listedChecks } from "./fake-plan.ts";
import path from "node:path";

const REVIEWERS: ReadonlySet<string> = new Set(["frieren", "richter", "ubel"]),
  schemaOf = async (args: readonly string[]): Promise<string> => {
    if (args.includes("--json-schema")) {
      return after(args, "--json-schema");
    }
    if (args.includes("--output-schema")) {
      const schema = await readOr(after(args, "--output-schema"), "");
      return schema;
    }
    return "";
  },
  // A seed reads, then answers as the call it seeds must: JSON when a schema is attached.
  seedFinal = async (played: Played): Promise<Final> => {
    const schema = await schemaOf(played.call.args),
      { seedFor } = played.call;
    if (!schema) {
      return `brief for ${seedFor}`;
    }
    if (schema.includes('"findings"')) {
      return { checked: ["fake seed"], findings: [], summary: `Context loaded for ${seedFor}.`, verdict: "CONTEXT_LOADED" };
    }
    return { items: [], result: "CONTEXT_LOADED", summary: "Context loaded." };
  },
  // Asks DENKEN for a permission through the engine, then stops, as the role files say.
  askPermission = async (played: Played, ask: JsonObject): Promise<Final> => {
    const script = groupOf(/node "(?<script>[^"]+)" request-permission "/u, played.call.prompt, "script");
    await runNode([script, "request-permission", played.call.runDir, "--need", textAt(ask, "need"), "--why", textAt(ask, "why")]);
    return `stopped: asked for ${textAt(ask, "need")}`;
  },
  reviewFinal = (played: Played): Final => {
    const review = at(played.step, "review");
    if (isRecord(review)) {
      return review;
    }
    return { checked: ["fake review"], findings: [], summary: `${played.call.role} found nothing to change`, verdict: "APPROVED" };
  },
  qaAnswer = async (played: Played): Promise<JsonObject> => {
    const qa = at(played.step, "qa");
    if (isRecord(qa)) {
      return qa;
    }
    return { items: await listedChecks(played.call.runDir), result: "PASS", summary: "every check passed on the running product" };
  },
  // GENAU leaves an evidence file per item, and points to it from the report.
  qaFinal = async (played: Played): Promise<Final> => {
    const answer = await qaAnswer(played),
      evidence = path.join(played.call.runDir, "calls", `${played.call.callId}.evidence`),
      items = await Promise.all(
        listAt(answer, "items")
          .filter((item) => isRecord(item))
          .map(async (item) => {
            const file = path.join(evidence, `${textAt(item, "id")}.txt`);
            await writeInto(file, `${textAt(item, "id")}: ${textAt(item, "result")}\n${textAt(played.step, "evidenceText")}`);
            return Object.assign(structuredClone(item), { evidence_files: [file] });
          }),
      );
    return Object.assign(structuredClone(answer), { items });
  },
  otherFinal = async (played: Played): Promise<Final> => {
    const ask = at(played.step, "requestPermission");
    if (isRecord(ask)) {
      const asked = await askPermission(played, ask);
      return asked;
    }
    if (REVIEWERS.has(played.call.role)) {
      return reviewFinal(played);
    }
    if (played.call.role === "genau") {
      const qa = await qaFinal(played);
      return qa;
    }
    return "";
  },
  // The final message of a call that is not a worker's; empty text when the call is a worker's.
  checkerFinal = async (played: Played): Promise<Final> => {
    if (played.call.role === "flamme") {
      const seed = await seedFinal(played);
      return seed;
    }
    const final = await otherFinal(played);
    return final;
  };

export { checkerFinal };
