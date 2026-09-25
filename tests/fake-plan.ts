/*
 * What the fake's METHODE plans and GENAU checks: the default TODO lists, a unit's lists written from
 * its request.md, and a passing answer for every QA item listed in todo-qa.md.
 */
import { groupOf, pad } from "./fake-text.ts";
import type { JsonObject } from "./test-types.ts";
import path from "node:path";
import { readOr } from "./fake-io.ts";

const DEFAULT_TODO_DEV =
    "# Development TODO\n\n## Acceptance\n- REQ-001. One. Done when: one works.\n- REQ-002. Two. Done when: two works.\n\n## Do not build\n- OUT-001. Three.\n- LATER-001. Four.\n\n## Cautions\n- CAUTION-001. Keep it small.\n\n## TODO\n- [ ] DEV-001 (REQ-001) build one\n- [ ] DEV-002 (REQ-002) build two\n\n## Open questions\n- None\n",
  DEFAULT_TODO_QA = "# QA TODO\n\n## Checks\n- [ ] QA-001 (REQ-001) check one\n- [ ] QA-002 (REQ-002) check two\n",
  SECTION = 1,
  FIRST_NUMBER = 1,
  CHECK_MAX = 60,
  START = 0,
  LISTED = /^- \[[ xX]\] (?<id>QA-\d{3,}) \((?<refs>[^)]*)\)\s*(?<text>.*)$/gmu,
  pass = (count: number): JsonObject => ({ check: `check ${count}`, evidence: "ok", how_verified: "fake", id: `QA-${pad(count)}`, request_item: `REQ-${pad(count)}`, result: "PASS" }),
  // A passing answer for a listed QA item; one whose line names no REQ item has no request_item.
  listedCheck = (id: string, refs: string, text: string): JsonObject => {
    const check: JsonObject = { check: text.slice(START, CHECK_MAX), evidence: "ok", how_verified: "fake", id, result: "PASS" },
      request = groupOf(/(?<req>REQ-\d{3,})/u, refs, "req");
    if (request) {
      return Object.assign(structuredClone(check), { request_item: request });
    }
    return check;
  },
  // A passing answer for every QA item listed in todo-qa.md; the two default ones when none is listed.
  listedChecks = async (runDir: string): Promise<readonly JsonObject[]> => {
    const text = await readOr(path.join(runDir, "todo-qa.md"), ""),
      found: JsonObject[] = [];
    for (const match of text.matchAll(LISTED)) {
      const groups = match.groups ?? {};
      found.push(listedCheck(groups["id"] ?? "", groups["refs"] ?? "", groups["text"] ?? ""));
    }
    if (found.length > START) {
      return found;
    }
    return [pass(FIRST_NUMBER), pass(FIRST_NUMBER + FIRST_NUMBER)];
  },
  partOf = (request: string, heading: string): string => {
    const after = request.split(new RegExp(String.raw`^## ${heading}\s*$`, "mu")).at(SECTION) ?? "",
      [part = ""] = after.split(/^## /mu);
    return part;
  },
  itemsOf = (request: string, heading: string, prefix: string): readonly string[] =>
    partOf(request, heading)
      .split("\n")
      .filter((line) => new RegExp(String.raw`^- ${prefix}-\d{3,}`, "u").test(line));

export { DEFAULT_TODO_DEV, DEFAULT_TODO_QA, FIRST_NUMBER, itemsOf, listedChecks };
