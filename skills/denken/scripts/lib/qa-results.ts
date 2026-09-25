// GENAU's report checked against todo-qa.md: every QA item must be reported, and one that is missing counts as failed.
import type { QaItem, QaOutput } from "./types-call.ts";
import type { QaView } from "./types-qa.ts";
import type { RunStore } from "./types-store.ts";
import { TODO_QA } from "./paths.ts";
import type { TodoItem } from "./types-todo.ts";
import { parseItems } from "./todo.ts";
import { readRunFile } from "./store.ts";

const REQ_KEY = /^REQ-\d{3,}$/u,
  missingItem = (item: TodoItem): QaItem => ({
    check: item.text,
    evidence: "missing from the QA report",
    evidence_files: [],
    how_verified: "",
    id: item.key,
    reproduce: "",
    request_item: item.refs.find((ref) => ref.startsWith("REQ-")) ?? "",
    result: "FAIL",
  }),
  // The request items a QA item checks: the one it names, else the REQ items its TODO line refers to.
  reqsFor =
    (qaItems: readonly TodoItem[]) =>
    (item: QaItem): readonly string[] => {
      if (REQ_KEY.test(item.request_item)) {
        return [item.request_item];
      }
      return (qaItems.find((todo) => todo.key === item.id) ?? { refs: [] }).refs.filter((ref) => ref.startsWith("REQ-"));
    },
  qaResults = async (store: RunStore, output: QaOutput): Promise<QaView> => {
    const { items: qaItems } = parseItems(await readRunFile(store.dir, TODO_QA), "QA"),
      reported = new Set(output.items.map((item) => item.id)),
      items = [...output.items, ...qaItems.filter((todo) => !reported.has(todo.key)).map((todo) => missingItem(todo))],
      reqsOf = reqsFor(qaItems),
      identityOf = (item: QaItem): string => {
        const [first = item.id] = reqsOf(item);
        return first;
      },
      dismissed = new Set(store.current().dismissed.dev);
    return { failing: items.filter((item) => item.result === "FAIL" && !dismissed.has(identityOf(item))), identityOf, items, reqsOf };
  };

export { qaResults };
