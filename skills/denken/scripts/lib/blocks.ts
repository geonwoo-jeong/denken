// Stopping the run for DENKEN or the user, and showing DENKEN why.
import type { Block, BlockInfo } from "./types-block.ts";
import type { BlockKind } from "./types-names.ts";
import { NO_BLOCK } from "./state-zero.ts";
import type { RunStore } from "./types-store.ts";
import { now } from "./text.ts";

interface BlockRequest {
  readonly info: BlockInfo;
  readonly reason: string;
}

// What a block shows: its details, with its kind, reason and since.
type BlockView = BlockInfo & Pick<Block, "kind" | "reason" | "since">;

const block = (store: RunStore, kind: BlockKind, request: BlockRequest): void => {
    store.apply({ blocked: { info: request.info, kind, reason: request.reason, since: now() } });
  },
  unblock = (store: RunStore): void => {
    store.apply({ blocked: NO_BLOCK });
  },
  isBlocked = (blocked: Block): boolean => blocked.kind !== "none",
  blockView = (blocked: Block): BlockView =>
    Object.assign(structuredClone(blocked.info), { kind: blocked.kind, reason: blocked.reason, since: blocked.since });

export { block, blockView, isBlocked, unblock };
