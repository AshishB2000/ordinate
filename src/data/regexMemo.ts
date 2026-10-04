// User regexes on the server — the SYNC half (T6.4, threat-model R1). MAIN.
//
// A user pattern (a regex split / replace, a keyword rule, a quality `regex`
// rule) can backtrack for minutes on one hostile cell, V8 cannot interrupt a
// match, and the subset needs the `u` flag, which V8's linear engine does not
// cover. So on the server every such match runs in the regex worker
// (src/engine/regexPool.ts) under a deadline, and the async callers
// (./regexOffThread.ts) hand the answers to the sync folds as a MEMO:
// input text → that text's result, computed by the very function the fold
// would have run (./regexSubset.ts, keywordRules, qualityRegex).
//
// A fold that reaches a user regex WITHOUT a memo on the server refuses (the
// step is skipped, the rule errors) instead of running it on the request
// thread — so a caller nobody converted shows a warning; it never hangs a pod.
// The desktop has no memo and runs the pattern itself, as it always did.

import { isServerMode } from '../server/mode';

export { regexRefusedWarning } from './regexMessages';

/** Cell text → the regex worker's result for it (string, string[], category or boolean, per op). */
export type RegexMemo = ReadonlyMap<string, unknown>;

/** On the server, where user patterns run only in the regex worker. */
export function regexWorkerOnly(): boolean {
  return isServerMode();
}

/** True when a fold must not run a user regex itself: on the server, with any row to scan. */
export function inlineRegexRefused(rows: number): boolean {
  return rows > 0 && regexWorkerOnly();
}
