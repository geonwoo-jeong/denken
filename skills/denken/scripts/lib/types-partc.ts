// Shapes used only inside the configuration, levels and ticks: config layers, notes and requests.
import type { Agent, ConfigResult, Level, Provider, ProviderStatuses } from "./types-config.ts";
import type { ItemPrefix, TodoItem } from "./types-todo.ts";
import type { Role, TextMap } from "./types-names.ts";
import type { JsonObject } from "./types-json.ts";
import type { TickEntry } from "./types-call.ts";

// A config file as read: its values (empty when missing), whether it exists, and why it is unreadable.
interface ConfigLayer {
  readonly data: JsonObject;
  readonly error: string;
  readonly path: string;
  readonly present: boolean;
}

// Errors and warnings found while resolving the configuration, in the order they were found.
interface Notes {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

// The resolved configuration, and whether the providers were probed at all.
interface Resolution {
  readonly probed: boolean;
  readonly result: ConfigResult;
}

// What every pick of a role's agent needs to know about the providers.
interface ProviderContext {
  readonly allowed: readonly string[];
  readonly status: ProviderStatuses;
  readonly usable: readonly Provider[];
}

/*
 * One role to pick an agent for: its merged spec, the provider to use by default, the provider it
 * must avoid (the worker it checks; empty for a worker) and its network default.
 */
interface PickRequest {
  readonly avoid: Provider | "";
  readonly fallback: Provider;
  readonly label: Role;
  readonly networkDefault: boolean;
  readonly spec: JsonObject;
}

interface Picked extends Notes {
  readonly agent: Agent;
}

// A level or override DENKEN asked for: --level, --model or --effort with its "<key>=<value>".
interface ChoicePair {
  readonly kind: string;
  readonly text: string;
}

interface LevelChoice {
  readonly key: string;
  readonly roles: readonly Role[];
  readonly value: string;
}

interface OverrideChoice extends LevelChoice {
  readonly kind: string;
}

// The level a role runs at, before it is mapped to a model and effort.
interface RoleLevel {
  readonly level: Level;
  readonly role: Role;
}

// A tick to write into a TODO file, or to take back (ticked false); empty evidence leaves the evidence line.
interface TickChange {
  readonly evidence: string;
  readonly key: string;
  readonly prefix: ItemPrefix;
  readonly ticked: boolean;
}

// A TODO item with the file it is in.
interface PlacedItem {
  readonly file: string;
  readonly item: TodoItem;
}

// What a diff shows about tests: lines deleted from test files (by file) and skip markers added.
interface DiffFacts {
  readonly deletions: TextMap<number>;
  readonly file: string;
  readonly skips: readonly string[];
}

// The facts UBEL's scope report is written from.
interface ScopeFacts {
  readonly changed: readonly string[];
  readonly deletions: TextMap<number>;
  readonly fixes: readonly TodoItem[];
  readonly items: readonly TodoItem[];
  readonly ledger: TextMap<TickEntry>;
  readonly report: string;
  readonly skips: readonly string[];
}

// A merged configuration value, and the errors found in it.
interface Checked<Value> {
  readonly errors: readonly string[];
  readonly value: Value;
}

// What the configuration is resolved from once the providers are known.
interface ResolveBase {
  readonly allowed: readonly string[];
  readonly layers: readonly ConfigLayer[];
  readonly providerErrors: readonly string[];
  readonly sources: readonly string[];
  readonly status: ProviderStatuses;
  readonly usable: readonly Provider[];
}

// One configured level in a config file: its spec, or why it cannot be used.
interface LevelEvent {
  readonly error: string;
  readonly key: string;
  readonly spec: JsonObject;
}

// The worker and reviewer separation, checked stage by stage.
interface Separation {
  readonly errors: readonly string[];
  readonly sameReviewer: readonly string[];
}

// A config command as given: the command, its key and value, and the file it changes.
interface ConfigRequest {
  readonly command: string;
  readonly hasValue: boolean;
  readonly json: boolean;
  readonly key: string;
  readonly target: string;
  readonly value: string;
}

export type { Checked, ChoicePair, ConfigLayer, ConfigRequest, DiffFacts, LevelEvent, ResolveBase, Separation, LevelChoice, Notes, OverrideChoice, Picked, PickRequest, PlacedItem, ProviderContext, Resolution, RoleLevel, ScopeFacts, TickChange };
