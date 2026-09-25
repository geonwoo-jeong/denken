// A call played: counted and logged, its step's side effects done, its final message made and printed.
import type { FakeCall, Final, Played } from "./fake-types.ts";
import { attemptOf, logCall, stepOf } from "./fake-step.ts";
import { before } from "./fake-before.ts";
import { checkerFinal } from "./fake-checkers.ts";
import { output } from "./fake-output.ts";
import { workFinal } from "./fake-work.ts";

// A checker's, a seed's or a permission request's final message; a worker's when it is none of those.
const finalOf = async (played: Played): Promise<Final> => {
    const final = await checkerFinal(played);
    if (final === "") {
      const work = await workFinal(played);
      return work;
    }
    return final;
  },
  playStep = async (played: Played): Promise<void> => {
    if (await before(played)) {
      return;
    }
    await output(played, await finalOf(played));
  },
  play = async (call: FakeCall): Promise<void> => {
    const attempt = await attemptOf(call);
    await logCall(call, attempt);
    await playStep({ call, step: await stepOf(call, attempt) });
  };

export { play };
