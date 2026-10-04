// The regex worker — a worker_thread that runs USER regexes off the request
// thread (T6.4, threat-model R1). Started and fed by ./regexPool.ts; never
// imported for its code (the pool imports its types only).
//
// One message = one op over a BATCH of distinct texts (never one per cell).
// A catastrophic pattern simply never answers: the pool's deadline fires and it
// terminates this thread — the only way to stop a running V8 match.
//
// It imports nothing but the pure leaf modules that BUILD the per-text
// functions the folds run (regexSubset, keywordRules, qualityRegex), so its
// answer is the fold's answer by construction, and it starts in milliseconds
// (no DuckDB, no catalog, no Electron).
//
// Protocol: in { spec, texts } → out { results } | { error }.

import { parentPort } from 'worker_threads';
import { regexReplacer, regexSplitter } from '../data/regexSubset';
import { categorize, compileRules } from '../analysis/text/keywordRules';
import type { KeywordRule } from '../analysis/text/keywordRules';
import { jsRegex } from '../analysis/qualityRegex';

export type RegexSpec =
  /** replace_values, mode regex: text → text after every rule, in order. */
  | { op: 'replace'; rules: Array<{ from: string; to: string }>; ignoreCase: boolean }
  /** split_column, mode regex: text → its parts. */
  | { op: 'split'; pattern: string; ignoreCase: boolean }
  /** keyword_rules: text → the first matching rule's category, or `otherwise`. */
  | { op: 'keyword'; rules: KeywordRule[]; otherwise: string | null }
  /** A quality `regex` rule: text → does it match in full. */
  | { op: 'match'; pattern: string };

export function textFn(spec: RegexSpec): (text: string) => unknown {
  switch (spec.op) {
    case 'replace': return regexReplacer(spec.rules, spec.ignoreCase);
    case 'split': return regexSplitter(spec.pattern, spec.ignoreCase);
    case 'keyword': {
      const compiled = compileRules(spec.rules);
      return (text) => categorize(text, compiled, spec.otherwise);
    }
    case 'match': {
      const re = jsRegex(spec.pattern);
      return (text) => re.test(text);
    }
  }
}

const port = parentPort;
if (port) {
  port.on('message', (msg: { spec: RegexSpec; texts: string[] }) => {
    try {
      port.postMessage({ results: msg.texts.map(textFn(msg.spec)) });
    } catch (e) {
      port.postMessage({ error: e instanceof Error ? e.message : 'The pattern failed' });
    }
  });
}
