// Reading the fake's prompt and arguments: a flag's value, a pattern's named group, a zero-padded number.
const NEXT = 1,
  ID_WIDTH = 3,
  // The value after a flag. Like the fake it replaces, a missing flag gives the first argument.
  after = (args: readonly string[], flag: string): string => args[args.indexOf(flag) + NEXT] ?? "",
  groupOf = (pattern: Readonly<RegExp>, text: string, name: string): string => {
    const match = pattern.exec(text);
    if (match === null) {
      return "";
    }
    return (match.groups ?? {})[name] ?? "";
  },
  // One named group of every match of a global pattern, in order.
  allGroups = (pattern: Readonly<RegExp>, text: string, name: string): readonly string[] => {
    const found: string[] = [];
    for (const match of text.matchAll(pattern)) {
      found.push((match.groups ?? {})[name] ?? "");
    }
    return found;
  },
  pad = (count: number): string => String(count).padStart(ID_WIDTH, "0");

export { after, allGroups, groupOf, pad };
