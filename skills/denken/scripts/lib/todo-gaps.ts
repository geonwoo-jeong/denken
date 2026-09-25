// The engine's check of METHODE's TODO lists against request.md: coverage gaps, each with its own identity.
import type { ItemProblem, ParsedItems, RequestPrefix, TodoItem } from "./types-todo.ts";
import { REQUEST, TODO_DEV, TODO_QA } from "./paths.ts";
import { REQUEST_PREFIXES, contract, parseRequest, sectionItems, sectionOf } from "./request.ts";
import { hasItems, isEmpty } from "./lists.ts";
import type { Finding } from "./types-items.ts";
import type { TodoInputs } from "./types-parta.ts";
import { engineFinding } from "./engine-finding.ts";
import { parseItems } from "./todo.ts";
import { readRunFile } from "./store.ts";

// Where todo-dev.md copies request.md: each section and the request items it holds, word for word.
const COPIES: readonly (readonly [string, readonly RequestPrefix[]])[] = [
    ["Acceptance", ["REQ"]],
    ["Do not build", ["OUT", "LATER"]],
    ["Cautions", ["CAUTION"]],
  ],
  FORMAT_CHANGE = "Fix the list format: one checkbox line per item, each id once, inside its section.",
  gapIf = (condition: boolean, gap: Finding): readonly Finding[] => {
    if (condition) {
      return [gap];
    }
    return [];
  },
  emptyGaps = (inputs: TodoInputs): readonly Finding[] => [
    ...gapIf(
      isEmpty(inputs.dev.items),
      engineFinding({ file: TODO_DEV, identity: "todo-dev-empty", problem: "todo-dev.md has no DEV items", required_change: 'Write the development TODO under "## TODO" as "- [ ] DEV-001 (REQ-001) ..." items.' }),
    ),
    ...gapIf(
      isEmpty(inputs.qa.items),
      engineFinding({ file: TODO_QA, identity: "todo-qa-empty", problem: "todo-qa.md has no QA items", required_change: 'Write the QA TODO under "## Checks" as "- [ ] QA-001 (REQ-001) ..." items.' }),
    ),
  ],
  // A problem with a whole section names no item.
  itemOfProblem = (problem: ItemProblem): string => {
    if (problem.key === "section") {
      return "";
    }
    return problem.key;
  },
  formatGapsOf = (file: string, parsed: ParsedItems): readonly Finding[] =>
    parsed.problems.map((problem) =>
      engineFinding({ file, identity: `todo-format-${problem.key}`, problem: `${file}: ${problem.problem}`, required_change: FORMAT_CHANGE, todo: itemOfProblem(problem) }),
    ),
  requestOfPrefix = (prefix: RequestPrefix, key: string): string => {
    if (prefix === "REQ") {
      return key;
    }
    return "";
  },
  // STARK's contract is the copied text itself, so the copies must match request.md.
  copyGapsFor = (inputs: TodoInputs, heading: string, prefix: RequestPrefix): readonly Finding[] => {
    const copied = sectionItems(sectionOf(inputs.devText, heading).body, prefix);
    return inputs.request.sections[prefix].items.flatMap((item): readonly Finding[] => {
      const copy = copied.findLast((entry) => entry.key === item.key),
        base = { file: TODO_DEV, identity: `todo-copy-${item.key}`, request_item: requestOfPrefix(prefix, item.key) };
      if (!copy) {
        return [engineFinding(Object.assign(base, { problem: `${item.key} is missing from the ${heading} section of todo-dev.md`, required_change: `Copy ${item.key} from request.md into "## ${heading}", word for word.` }))];
      }
      return gapIf(
        contract(copy.text) !== contract(item.text),
        engineFinding(Object.assign(base, { problem: `${item.key} in the ${heading} section of todo-dev.md differs from request.md`, required_change: `Copy ${item.key} from request.md word for word.` })),
      );
    });
  },
  copyGaps = (inputs: TodoInputs): readonly Finding[] => COPIES.flatMap(([heading, prefixes]) => prefixes.flatMap((prefix) => copyGapsFor(inputs, heading, prefix))),
  covers = (items: readonly TodoItem[], key: string): boolean => items.some((item) => item.refs.includes(key)),
  coverageGaps = (inputs: TodoInputs): readonly Finding[] =>
    inputs.request.sections.REQ.items.flatMap((item) => [
      ...gapIf(
        hasItems(inputs.dev.items) && !covers(inputs.dev.items, item.key),
        engineFinding({ file: TODO_DEV, identity: item.key, problem: `${item.key} has no development TODO`, request_item: item.key, required_change: `Add a DEV item that implements ${item.key}.` }),
      ),
      ...gapIf(
        hasItems(inputs.qa.items) && !covers(inputs.qa.items, item.key),
        engineFinding({ file: TODO_QA, identity: item.key, problem: `${item.key} has no QA TODO`, request_item: item.key, required_change: `Add a QA item that verifies ${item.key}.` }),
      ),
    ]),
  whatBoundsIt = (ref: string): string => {
    if (ref.startsWith("OUT-")) {
      return "puts out of scope";
    }
    return "defers (not now)";
  },
  // A DEV item builds REQ items and may name the cautions it keeps; never what is out of scope or deferred.
  devRefGap = (inputs: TodoInputs, item: TodoItem, ref: string): readonly Finding[] => {
    const base = { file: TODO_DEV, identity: item.key, todo: item.key };
    if (/^(?:OUT|LATER)-/u.test(ref)) {
      return [engineFinding(Object.assign(base, { problem: `${item.key} builds ${ref}, which the request ${whatBoundsIt(ref)}`, required_change: `Remove ${item.key} or the work for ${ref}.` }))];
    }
    return gapIf(
      !inputs.known.includes(ref),
      engineFinding(Object.assign(base, { problem: `${item.key} refers to ${ref}, which request.md does not define`, required_change: "Refer only to REQ items in request.md." })),
    );
  },
  devRefGaps = (inputs: TodoInputs): readonly Finding[] =>
    inputs.dev.items.flatMap((item) => [
      ...gapIf(
        !item.refs.some((ref) => ref.startsWith("REQ-")),
        engineFinding({ file: TODO_DEV, identity: item.key, problem: `${item.key} does not name the request item it implements`, required_change: `Add the REQ item(s) in parentheses after ${item.key}.`, todo: item.key }),
      ),
      ...item.refs.flatMap((ref) => devRefGap(inputs, item, ref)),
    ]),
  // A QA item may check any request item, a caution included.
  qaRefGaps = (inputs: TodoInputs): readonly Finding[] =>
    inputs.qa.items.flatMap((item) => [
      ...gapIf(
        isEmpty(item.refs),
        engineFinding({
          file: TODO_QA,
          identity: item.key,
          problem: `${item.key} does not name the request item it verifies`,
          required_change: `Add the REQ, OUT, LATER or CAUTION item it checks in parentheses after ${item.key}.`,
          todo: item.key,
        }),
      ),
      ...item.refs
        .filter((ref) => !inputs.known.includes(ref))
        .map((ref) => engineFinding({ file: TODO_QA, identity: item.key, problem: `${item.key} refers to ${ref}, which request.md does not define`, required_change: "Refer only to items in request.md.", todo: item.key })),
    ]),
  // Coverage gaps, each with its own identity so one gap cannot hide or dismiss another.
  todoGaps = async (runDir: string): Promise<readonly Finding[]> => {
    const [requestText, devText, qaText] = await Promise.all([readRunFile(runDir, REQUEST), readRunFile(runDir, TODO_DEV), readRunFile(runDir, TODO_QA)]),
      request = parseRequest(requestText),
      inputs: TodoInputs = {
        dev: parseItems(devText, "DEV"),
        devText,
        known: REQUEST_PREFIXES.flatMap((prefix) => request.sections[prefix].items.map((item) => item.key)),
        qa: parseItems(qaText, "QA"),
        request,
      };
    return [
      ...emptyGaps(inputs),
      ...formatGapsOf(TODO_DEV, inputs.dev),
      ...formatGapsOf(TODO_QA, inputs.qa),
      ...copyGaps(inputs),
      ...coverageGaps(inputs),
      ...devRefGaps(inputs),
      ...qaRefGaps(inputs),
    ];
  };

export { todoGaps };
