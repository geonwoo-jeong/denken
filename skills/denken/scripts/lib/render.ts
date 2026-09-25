// Markdown for the record's step files: a review's findings.
import { hasItems, increment } from "./lists.ts";
import type { Finding } from "./types-items.ts";
import type { ReviewOutput } from "./types-call.ts";
import type { Shown } from "./types-parta.ts";
import { framed } from "./text.ts";

type ReviewShown = Pick<ReviewOutput, "checked" | "findings" | "summary">;

const lineRef = (finding: Finding): string => {
    if (finding.line_start) {
      return `:${finding.line_start}`;
    }
    return "";
  },
  fileRef = (finding: Finding): string => framed(" ", finding.file, lineRef(finding)),
  itemOf = (finding: Finding, index: number): string =>
    `${increment(index)}. [${finding.topic}]${fileRef(finding)}${framed(" (", finding.request_item, ")")}${framed(" (", finding.todo, ")")}: ${finding.problem}\n   Required change: ${finding.required_change}`,
  wordOf = (shown: Shown, blocking: readonly Finding[]): string => {
    if (shown.word) {
      return shown.word;
    }
    if (hasItems(blocking)) {
      return "REJECTED";
    }
    return "APPROVED";
  },
  summaryLines = (summary: string): readonly string[] => {
    if (summary) {
      return [`> ${summary.trim().replaceAll("\n", "\n> ")}`, ""];
    }
    return [];
  },
  renderFindings = (title: string, review: ReviewShown, shown: Shown): string => {
    const blocking = review.findings.filter((finding) => finding.severity === "blocking"),
      nonblocking = review.findings.filter((finding) => finding.severity === "nonblocking");
    return [
      `# ${title}`,
      "",
      `Verdict: **${wordOf(shown, blocking)}**${framed(" (", shown.note, ")")}`,
      "",
      ...summaryLines(review.summary),
      "## Blocking findings",
      "",
      blocking.map((finding, index) => itemOf(finding, index)).join("\n") || "None.",
      "",
      "## Nonblocking findings",
      "",
      nonblocking.map((finding, index) => itemOf(finding, index)).join("\n") || "None.",
      "",
      "## What was checked (the basis for the verdict)",
      "",
      review.checked.map((checked) => `- ${checked}`).join("\n") || "- (not stated)",
      "",
    ].join("\n");
  };

export { renderFindings };
