// One Assistant question keeps what it read for its length (docs/assistant/00-design.md, "Scale rules"). MAIN PROCESS.
//
// A question asked for the same things several times over: every dataset and every term four times, the vocabulary a
// spec may name up to three, catalog.json parsed 50 to 60 times, each record read its own Postgres transaction. Inside
// `keepReads` a record is read once (recordFs.withReadMemo), and what is built from records once (`perAsk`; the parsed
// catalog, ../app/catalog `loadShared`). Any write through recordFs forgets all of it. What is kept is shared by every
// reader of the question, so no reader may change it.

import * as recordFs from '../app/recordFs';
import { inFanOut } from '../data/rowAccess';

let on = true;
/** Test hook: off, a handler reads everything every time (the NEGATIVE CONTROL of scripts/test-askBudget.ts). */
export function _setAskMemo(keep: boolean): void {
  on = keep;
}

/** `handler`, its reads kept for the length of one call. For a handler that reads, then writes only under a record's lock. */
export function keepReads<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return (...args) => (on ? recordFs.withReadMemo(() => handler(...args)) : handler(...args));
}

/** `build()` once per key inside a kept call, every time outside one; keyed as hiddenAnywhere is, since what is hidden depends on who asks. A failure is not remembered. */
export function perAsk<T>(key: string, build: () => Promise<T>): Promise<T> {
  return recordFs.memoRead(`${inFanOut() ? 'fanout' : 'caller'}\0${key}`, build);
}
