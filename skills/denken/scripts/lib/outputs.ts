/*
 * What reviewers and GENAU answer, checked against their schema and taken into typed values. A null
 * in the answer (the schemas allow it for optional fields) becomes an empty text or 0.
 */
import type { JsonObject, JsonValue } from "./types-json.ts";
import type { QaItem, QaOutput, ReviewOutput } from "./types-call.ts";
import { asRecord, isList, isRecord, numberOf, recordsOf, stringsOf, textOf } from "./json.ts";
import type { Finding } from "./types-items.ts";
import { NONE } from "./lists.ts";

const REVIEW_VERDICTS: ReadonlySet<string> = new Set(["APPROVED", "CHANGES_REQUESTED"]),
  SEVERITIES: ReadonlySet<string> = new Set(["blocking", "nonblocking"]),
  RESULTS: ReadonlySet<string> = new Set(["PASS", "FAIL"]),
  QA_ID = /^QA-\d{3,}$/u,
  findingOf = (record: JsonObject): Finding => ({
    file: textOf(record, "file"),
    identity: textOf(record, "identity"),
    line_end: numberOf(record, "line_end", NONE),
    line_start: numberOf(record, "line_start", NONE),
    problem: textOf(record, "problem"),
    request_item: textOf(record, "request_item"),
    required_change: textOf(record, "required_change"),
    severity: textOf(record, "severity"),
    source: textOf(record, "source"),
    todo: textOf(record, "todo"),
    topic: textOf(record, "topic"),
  }),
  qaItemOf = (record: JsonObject): QaItem => ({
    check: textOf(record, "check"),
    evidence: textOf(record, "evidence"),
    evidence_files: stringsOf(record, "evidence_files"),
    how_verified: textOf(record, "how_verified"),
    id: textOf(record, "id"),
    reproduce: textOf(record, "reproduce"),
    request_item: textOf(record, "request_item"),
    result: textOf(record, "result"),
  }),
  toReviewOutput = (value: unknown): ReviewOutput => {
    const record = asRecord(value);
    return {
      checked: stringsOf(record, "checked"),
      findings: recordsOf(record, "findings").map((item) => findingOf(item)),
      summary: textOf(record, "summary"),
      verdict: textOf(record, "verdict"),
    };
  },
  toQaOutput = (value: unknown): QaOutput => {
    const record = asRecord(value);
    return { items: recordsOf(record, "items").map((item) => qaItemOf(item)), result: textOf(record, "result"), summary: textOf(record, "summary") };
  },
  validFinding = (item: JsonValue): boolean =>
    isRecord(item) && SEVERITIES.has(textOf(item, "severity")) && typeof item["topic"] === "string" && typeof item["problem"] === "string",
  validItem = (item: JsonValue): boolean => isRecord(item) && QA_ID.test(textOf(item, "id")) && RESULTS.has(textOf(item, "result")),
  validReview = (value: unknown): boolean => {
    if (!isRecord(value)) {
      return false;
    }
    const { findings } = value;
    return REVIEW_VERDICTS.has(textOf(value, "verdict")) && isList(findings) && findings.every((item) => validFinding(item));
  },
  validQa = (value: unknown): boolean => {
    if (!isRecord(value)) {
      return false;
    }
    const { items } = value;
    return RESULTS.has(textOf(value, "result")) && isList(items) && items.length > NONE && items.every((item) => validItem(item));
  },
  // CONTEXT_LOADED is FLAMME's answer when it seeds a checker; from a real review or QA call it is not a result.
  validOutput = (mode: string, value: unknown): boolean => {
    if (mode === "review") {
      return validReview(value);
    }
    return validQa(value);
  };

export { toQaOutput, toReviewOutput, validOutput };
