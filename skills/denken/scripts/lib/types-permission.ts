// DENKEN's decision on a permission request, as the grant and deny commands take it.
import type { ActiveCall } from "./types-items.ts";
import type { Grants } from "./types-config.ts";

interface Decision {
  readonly call: ActiveCall;
  readonly decision: string;
  readonly grant: Grants;
  readonly id: string;
  readonly note: string;
  readonly userSaid: string;
  readonly what: string;
}

export type { Decision };
