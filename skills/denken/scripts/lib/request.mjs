// request.md, DENKEN's summary of the request: its sections and items, and the checks on it.
import { REQUEST } from "./core.mjs";
import { readRunFile } from "./state.mjs";

export function section(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, "i").test(l.trim()));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

// Items "- REQ-001. ..." in a section, each with the text of its line and any continuation lines.
export function sectionItems(body, prefix) {
  const items = [];
  for (const line of (body ?? "").split("\n")) {
    const m = line.match(new RegExp(`^\\s*[-*]\\s*[*_\`]*(${prefix}-\\d{3,})\\b`));
    if (m) items.push({ key: m[1], text: line });
    else if (items.length && line.trim() && !/^\s*[-*]\s/.test(line.slice(0, 2))) items.at(-1).text += `\n${line}`;
  }
  return items;
}

export const REQUEST_SECTIONS = { REQ: "Confirmed", OUT: "Out of scope", LATER: "Not now", CAUTION: "Cautions" };

export function parseRequest(text) {
  const parsed = { goal: section(text, "Goal") };
  for (const [prefix, heading] of Object.entries(REQUEST_SECTIONS)) {
    const body = section(text, heading);
    parsed[prefix] = { present: body !== null, items: sectionItems(body, prefix) };
  }
  return parsed;
}

export function requestProblems(text) {
  const r = parseRequest(text);
  const problems = [];
  if (!r.goal?.trim()) problems.push('request.md needs a "## Goal" section with the user\'s goal');
  if (!r.REQ.present || !r.REQ.items.length) problems.push('request.md needs a "## Confirmed" section with items "- REQ-001. ... Done when: ..."');
  for (const item of r.REQ.items) if (!/done when/i.test(item.text)) problems.push(`${item.key} needs a "Done when:" condition someone could check`);
  for (const prefix of ["OUT", "LATER", "CAUTION"]) {
    if (!r[prefix].present) problems.push(`request.md needs a "## ${REQUEST_SECTIONS[prefix]}" section (items "- ${prefix}-001. ...", or "- None")`);
  }
  const unclear = [...text.matchAll(/\[NEEDS CLARIFICATION:([^\]]*)\]/gi)].map((m) => m[1].trim());
  if (unclear.length) problems.push(`request.md still has open questions for the user: ${unclear.join("; ")}`);
  return problems;
}

// An item's text as a contract: only whitespace, the bullet, emphasis and case may differ.
export const contract = (text) => text.replace(/^\s*[-*]\s*/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

// Ids are never reused. Once the user has confirmed an item, its id keeps that wording; a changed
// item gets a new id, so findings, rulings and TODO references keep meaning what they meant.
export function requestItems(runDir) {
  const r = parseRequest(readRunFile(runDir, REQUEST));
  return Object.keys(REQUEST_SECTIONS).flatMap((p) => r[p].items);
}

export function reusedIds(runDir, state) {
  const confirmed = state.requestIds ?? {};
  return requestItems(runDir)
    .filter((i) => i.key in confirmed && confirmed[i.key] !== contract(i.text))
    .map((i) => `${i.key} now reads differently from what the user confirmed. Ids are never reused: restore ${i.key}, or remove it and add the new wording under a number not used before`);
}
