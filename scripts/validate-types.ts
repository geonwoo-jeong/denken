// The shapes the skill validator works with: frontmatter values, and what a check found.
type Value = Readonly<Record<string, string>> | string;

interface Frontmatter {
  readonly body: string;
  readonly data: Readonly<Record<string, Value>>;
}

// A frontmatter key's value, and how many lines after the key's own it took.
interface Entry {
  readonly key: string;
  readonly taken: number;
  readonly value: Value;
}

// One step through the frontmatter's lines: the entries it read, and the line after them.
interface Step {
  readonly entries: readonly Entry[];
  readonly next: number;
}

// What checking one skill found: its name (empty when it has none), its errors and its warnings.
interface Checked {
  readonly errors: readonly string[];
  readonly file: string;
  readonly name: string;
  readonly warnings: readonly string[];
}

export type { Checked, Entry, Frontmatter, Step, Value };
