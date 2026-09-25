// A block as DENKEN is shown it: its details, kind, reason and since, with the action's own fields after them.
import type { Action } from "./types-flow.ts";
import type { Block } from "./types-block.ts";
import { blockView } from "./blocks.ts";

const shownWith = (blocked: Block, fields: Action): Action => Object.assign(blockView(blocked), fields),
  // The permission's call is DENKEN's to decide on, not to see twice: its details are left out.
  withoutCall = (blocked: Block, fields: Action): Action => {
    const entries: readonly (readonly [string, unknown])[] = Object.entries(blockView(blocked));
    return Object.assign(Object.fromEntries(entries.filter(([key]) => key !== "callInfo")), fields);
  };

export { shownWith, withoutCall };
