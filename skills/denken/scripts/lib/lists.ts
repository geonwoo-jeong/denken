// Small list and number helpers, so that counts, positions and steps have names.
import type { TextMap } from "./types-names.ts";

const NONE = 0,
  STEP = 1,
  LAST = -1,
  FIRST = 0,
  isEmpty = (list: readonly unknown[]): boolean => list.length === NONE,
  hasItems = (list: readonly unknown[]): boolean => list.length > NONE,
  increment = (value: number): number => value + STEP,
  decrement = (value: number): number => value - STEP,
  lastOf = <Item>(list: readonly Item[]): Item | undefined => list.at(LAST),
  unique = <Item>(list: readonly Item[]): readonly Item[] => [...new Set(list)],
  appended = <Item>(list: readonly Item[], item: Item): readonly Item[] => [...list, item],
  entriesOf = <Value>(record: TextMap<Value>): readonly (readonly [string, Value])[] => Object.entries(record),
  sum = (values: readonly number[]): number => {
    let total = NONE;
    for (const value of values) {
      total += value;
    }
    return total;
  },
  // Runs an async function on every item at once; the results keep the items' order.
  mapAsync = async <Item, Result>(items: readonly Item[], work: (item: Item) => Promise<Result>): Promise<readonly Result[]> => {
    const results = await Promise.all(
      items.map(async (item) => {
        const result = await work(item);
        return result;
      }),
    );
    return results;
  },
  // Runs an async function on each item in turn, each after the one before has finished.
  mapInOrder = async <Item extends object, Result>(items: readonly Item[], work: (item: Item) => Promise<Result>): Promise<readonly Result[]> => {
    const [first, ...rest] = items;
    if (!first) {
      return [];
    }
    return [await work(first), ...(await mapInOrder(rest, work))];
  },
  eachInOrder = async <Item extends object>(items: readonly Item[], work: (item: Item) => Promise<void>): Promise<void> => {
    await mapInOrder(items, work);
  },
  // A list with the last item that matches changed, by a function that makes its new version.
  withLast = <Item>(items: readonly Item[], matches: (item: Item) => boolean, change: (item: Item) => Item): readonly Item[] => {
    const index = items.findLastIndex((item) => matches(item));
    return items.map((item, position) => {
      if (position === index) {
        return change(item);
      }
      return item;
    });
  },
  // The items when the condition holds, none otherwise: for lists built from checks.
  onlyIf = <Item>(keep: boolean, items: readonly Item[]): readonly Item[] => {
    if (keep) {
      return items;
    }
    return [];
  },
  // A record with one entry set, and one without it.
  withEntry = <Value>(record: TextMap<Value>, key: string, value: Value): TextMap<Value> =>
    Object.fromEntries([...entriesOf(record), [key, value]]),
  withoutEntry = <Value>(record: TextMap<Value>, key: string): TextMap<Value> =>
    Object.fromEntries(entriesOf(record).filter(([name]) => name !== key)),
  /*
   * A copy of an object with some fields changed. The clone is the copy's own, so assigning to it
   * changes nothing the caller holds.
   */
  patch = <Value extends object>(base: Value, changes: Readonly<Partial<Value>>): Value =>
    Object.assign(structuredClone(base), changes);

export {
  appended,
  decrement,
  entriesOf,
  FIRST,
  hasItems,
  increment,
  isEmpty,
  LAST,
  eachInOrder,
  lastOf,
  mapAsync,
  mapInOrder,
  NONE,
  onlyIf,
  patch,
  STEP,
  sum,
  unique,
  withEntry,
  withLast,
  withoutEntry,
};
