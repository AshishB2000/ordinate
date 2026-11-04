// The formula golden: 5,000 seeded expressions (scripts/formulaCorpus.ts) answer
// exactly as they did on the parser before the builder refactor (semantic layer
// p8-02): ok, error, at, refs, cost, lods, and every value under Object.is. The
// golden (scripts/fixtures/golden/formula-corpus/answers.json) is never
// re-recorded: a mismatch is a bug in whatever changed.
//
//   npm run build:ts && node scripts/test-formulaGolden.js

process.env.TZ = 'UTC'; // toDate parses local time: the golden was recorded in UTC

import * as fs from 'fs';
import * as path from 'path';
import { ok, finish } from './selfcheck';
import { golden } from './golden';
import { answers, corpus, corpusRow, CORPUS_FUNCTIONS, CORPUS_ROWS, CORPUS_SIZE, type Answer } from './formulaCorpus';
import { encode } from '../src/server/wire';
import { stableStringify } from '../src/engine/queryCache';
import type { FValue, SourceSpan } from '../src/formula/formula';
import { FUNCTIONS, type EvalFn } from '../src/formula/formulaEval';
import { tokenize } from '../src/formula/formulaTokens';
import { parseTokens } from '../src/formula/formulaParse';
import { jsBuilder } from '../src/formula/formulaJs';
import type { CompareOp, FormulaBuilder } from '../src/formula/formulaBuilder';
import { isServerMode } from '../src/server/mode';

const G = golden<ReturnType<typeof answers>>('formula-corpus/answers');

const sameList = (a?: FValue[], b?: FValue[]): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
const sameAt = (a?: SourceSpan, b?: SourceSpan): boolean => a === b || (!!a && !!b && a.start === b.start && a.end === b.end);
function sameAnswer(g: Answer, n: Answer): boolean {
  return g.expr === n.expr && g.ok === n.ok && g.error === n.error && sameAt(g.at, n.at) && g.cost === n.cost &&
    stableStringify(g.refs) === stableStringify(n.refs) && stableStringify(g.lods) === stableStringify(n.lods) &&
    sameList(g.values, n.values) && sameList(g.table, n.table);
}

/** The function names the entries that compile call, lower-cased. */
function namedCalls(entries: Answer[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries.filter((x) => x.ok)) {
    const toks = tokenize(e.expr);
    toks.forEach((t, i) => {
      const next = toks[i + 1];
      if (t.kind === 'name' && next && next.kind === 'punc' && next.value === '(') out.add(t.value.toLowerCase());
    });
  }
  return out;
}

ok('local mode: regexes run without the linear engine, as when recorded', !isServerMode());
ok('the rows are the recorded ones', encode(G.rows) === encode(CORPUS_ROWS));
ok('the corpus is the recorded one, string for string', JSON.stringify(corpus()) === JSON.stringify(G.entries.map((e) => e.expr)));
const named = namedCalls(G.entries);
ok('5,000 expressions, some malformed, some with LODs, every frozen function called in one that compiles',
  G.entries.length === CORPUS_SIZE && G.entries.some((e) => !e.ok) && G.entries.some((e) => !!e.lods?.length) &&
  CORPUS_FUNCTIONS.every((f) => named.has(f)), CORPUS_FUNCTIONS.filter((f) => !named.has(f)).join(', '));

const now = answers(G.entries.map((e) => e.expr));
const diffs = G.entries.flatMap((g, i) => (sameAnswer(g, now.entries[i]) ? [] : [g.expr]));
ok('every answer is identical: ok, error, at, refs, cost, lods, and every value under Object.is', diffs.length === 0,
  `${diffs.length} differ: ` + diffs.slice(0, 5).join(' | '));

// NEGATIVE CONTROL: the comparison sees a -0 that became 0.
const signed = G.entries.find((e) => e.values?.some((v) => Object.is(v, -0)));
ok('NEGATIVE CONTROL: an answer whose -0 reads 0 is not the same answer',
  !!signed && !sameAnswer(signed, { ...signed, values: signed.values!.map((v) => (Object.is(v, -0) ? 0 : v)) }));

// A function added after the golden is not in its frozen list, and the golden is
// never re-recorded: it is covered by its own cases in a newer suite instead.
const CLOCK = ['now', 'today']; // they read the clock: no golden can pin them
/** A function added after the golden → the suite (scripts/<name>.ts) whose cases call it. */
const NEWER: Record<string, string> = {};
function uncovered(live: string[], newer: Record<string, string>): string[] {
  const calls = (f: string): boolean => !!newer[f] && fs.readFileSync(path.join(__dirname, newer[f] + '.ts'), 'utf8').includes(f + '(');
  return live.filter((f) => !CLOCK.includes(f) && !CORPUS_FUNCTIONS.includes(f) && !calls(f));
}
const live = Object.keys(FUNCTIONS);
ok('every function is in the frozen list, reads the clock, or has its own newer cases', uncovered(live, NEWER).length === 0,
  uncovered(live, NEWER).join(', '));
ok('NEGATIVE CONTROL: a function added with no cases is named',
  uncovered([...live, 'zz_new'], NEWER).join() === 'zz_new');

// The builder is what the golden guards: one operator built differently shows.
function evaluateWith(g: Answer, b: FormulaBuilder<EvalFn>): FValue[] {
  const { root } = parseTokens(tokenize(g.expr), b);
  return CORPUS_ROWS.map((_r, i) => {
    try {
      const v = root(corpusRow(i, g.lods?.length ?? 0));
      return v === undefined ? null : v;
    } catch {
      return null;
    }
  });
}
const compiled = G.entries.filter((g) => g.ok);
ok('parseTokens over jsBuilder() gives every recorded value', compiled.every((g) => sameList(g.values, evaluateWith(g, jsBuilder()))));
const js = jsBuilder();
const broken = { ...js, compare: (op: CompareOp, l: EvalFn, r: EvalFn, at: number): EvalFn =>
  (op === '=' ? (row) => l(row) === r(row) : js.compare(op, l, r, at)) };
const caught = compiled.filter((g) => !sameList(g.values, evaluateWith(g, broken))).length;
ok('NEGATIVE CONTROL: a builder whose `=` is `===` changes some recorded answers', caught > 0, String(caught));

finish();
