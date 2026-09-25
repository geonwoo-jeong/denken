// The confirmation in the run's state: what the user confirmed, and the request ids that keep their wording from now on.
import { appended, entriesOf } from "./lists.ts";
import { contract, requestItems } from "./request.ts";
import { NO_BLOCK } from "./state-zero.ts";
import type { RunStore } from "./types-store.ts";
import { confirmedHashes } from "./todo.ts";
import { now } from "./text.ts";

// Ids are never reused: once the user has confirmed an item, its id keeps that wording.
const applyConfirmation = async (store: RunStore, userSaid: string): Promise<void> => {
    const state = store.current(),
      confirmed = { at: now(), hashes: await confirmedHashes(store.dir), units: false, userSaid },
      items = await requestItems(store.dir);
    store.apply({
      blocked: NO_BLOCK,
      confirmations: appended(state.confirmations, confirmed),
      confirmed,
      requestIds: Object.fromEntries([...entriesOf(state.requestIds), ...items.map((item) => [item.key, contract(item.text)] as const)]),
    });
  };

export { applyConfirmation };
