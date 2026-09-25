// What the tests script the fake agents with: a request, review findings, QA items, and a split into units.
import type { JsonObject } from "./test-types.ts";
import { textAt } from "./test-json.ts";

const REQUEST =
    "# Request: test\n\n## Goal\nTest.\n\n## Confirmed\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Out of scope\n- OUT-001. Three.\n\n## Not now\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n",
  TWO_UNITS = "- UNIT-1 (REQ-001) One. Scope: `a/`.\n- UNIT-2 (REQ-002) Two. Scope: `b/`.\n",
  ID_WIDTH = 3,
  LINE = 1,
  idOf = (prefix: string, count: number): string => `${prefix}-${String(count).padStart(ID_WIDTH, "0")}`,
  baseFinding = (topic: string): JsonObject => ({
    file: "src.txt",
    line_end: LINE,
    line_start: LINE,
    problem: `${topic} problem`,
    required_change: `fix ${topic}`,
    severity: "blocking",
    topic,
  }),
  // A blocking finding on src.txt, line 1; extra fields override its defaults.
  finding = (topic: string, extra: JsonObject = {}): JsonObject => Object.assign(baseFinding(topic), extra),
  // A passing QA item says "ok"; a failing one says "boom" and how to reproduce it.
  outcome = (result: string): JsonObject => {
    if (result === "PASS") {
      return { evidence: "ok", result };
    }
    return { evidence: "boom", reproduce: "npm test", result };
  },
  // QA item number count, checking REQ item number count.
  qaItem = (count: number, result = "PASS", extra: JsonObject = {}): JsonObject =>
    Object.assign(outcome(result), { check: `check ${count}`, how_verified: "x", id: idOf("QA", count), request_item: idOf("REQ", count) }, extra),
  // A scenario step whose review rejects the work with these findings.
  changes = (...findings: readonly JsonObject[]): JsonObject => ({
    review: { checked: [], findings, summary: `rejected: ${findings.map((item) => textAt(item, "topic")).join(", ")}`, verdict: "CHANGES_REQUESTED" },
  });

export { changes, finding, idOf, qaItem, REQUEST, TWO_UNITS };
