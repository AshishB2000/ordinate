// The formula golden's corpus and recorder (scripts/test-formulaGolden.ts):
// 5,000 seeded expressions, and what today's compile() answers for each one.
//
// The golden was recorded ONCE, on the parser as it stood before the builder
// refactor (semantic layer p8-02), and is never re-recorded: a mismatch is a bug
// in whatever changed. Its inputs are frozen beside it in
// scripts/fixtures/golden/formula-corpus/: rows.json, the table every answer is
// evaluated over, and functions.json, the names the generator calls (never the
// live FUNCTIONS keys, so a function added later leaves every recorded string
// alone). The recording, for the record:
//
//   npm run build:ts && TZ=UTC node -e "require('fs').writeFileSync('scripts/fixtures/golden/formula-corpus/answers.json',
//     require('./src/server/wire').encode(require('./scripts/formulaCorpus.js').answers()))"

process.env.TZ = 'UTC'; // toDate parses local time

import { compile, type FValue, type SourceSpan } from '../src/formula/formula';
import type { LodSpec } from '../src/formula/formulaParse';
import { evaluateTable } from '../src/formula/lod';
import type { ColumnType } from '../src/data/parse';
import { golden } from './golden';
import { FIXED_CASES } from './formulaCorpusCases';

export const CORPUS_SEED = 0x5eed_0008;
export const CORPUS_SIZE = 5_000;
const MALFORMED = 1_000;

type Cell = string | number | null;
const TABLE = golden<{ columns: { name: string; type: ColumnType }[]; rows: Cell[][] }>('formula-corpus/rows');
/** n, m (number), t, u (text), d (date text), "x y" (a spaced name). */
export const CORPUS_COLUMNS = TABLE.columns;
/** 8 rows of cells. A boolean is the text a source keeps ('true', 'TRUE'): a cell is never a JS boolean. */
export const CORPUS_ROWS = TABLE.rows;
/** Every FUNCTIONS name but the clock's now/today, frozen when the golden was recorded. */
export const CORPUS_FUNCTIONS = golden<string[]>('formula-corpus/functions');

/** Row i as the map `evaluate` reads, with every `@lod:<j>` slot below `lodCount` set to 100 + j. */
export function corpusRow(i: number, lodCount: number): Record<string, FValue> {
  const m: Record<string, FValue> = {};
  CORPUS_COLUMNS.forEach((c, k) => {
    m[c.name] = CORPUS_ROWS[i][k] ?? null;
  });
  for (let j = 0; j < lodCount; j += 1) m['@lod:' + j] = 100 + j;
  return m;
}

// ── The generator ────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLS = ['[n]', '[m]', '[t]', '[u]', '[d]', '[x y]', 'n', 't', '[missing]', '[[p]]'];
const LITS = ['0', '0.5', '2.5', '-2.5', '1e21', "''", "' '", "'ß'", "'ΑΣ'", "'2024-02-29'", '1', '3', "'007'", "'abc'"];
const WORD_LITS = ['true', 'false', 'null'];
const ARITH = ['+', '-', '*', '/', '%'];
const CMP = ['=', '==', '!=', '>', '<', '>=', '<='];
const KINDS = ['fixed', 'include', 'exclude'];
const AGGS = ['sum', 'avg', 'min', 'max', 'count', 'countd'];
const DIMS = ['[t]', '[u]', '[x y]', '[d]', 't', '[n]', '[zz]'];
const PUNC = new Set(['(', ')', ',', '{', '}', ':']);
const STRAY = [')', '(', ',', ':', '}', '{', '+', '*', '=', 'THEN', 'END', 'ELSE', 'WHEN', 'IN', 'NOT', '[n]', '1', "'x'"];
const BAD_CHARS = [';', '@', '#', '$', '!', '&', '|', '?', '^', '~', '`'];
const UNKNOWN = ['sum', 'avg', 'count', 'countd', 'median', 'foo', 'roundup', 'nvl', 'fixed', 'trunc', 'concat_ws'];
const UNCLOSED = ['[n', "'abc", '"abc', '[[p', '{FIXED [t] : SUM([n])', 'round(1', '(1 + 2', '{', '['];

/** Expressions are built as pieces (a token, or a literal like `-2.5`), so a cut lands between two. */
function generator(rnd: () => number) {
  const int = (n: number): number => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  // Keyword case variants: IF, if, If, iF.
  const kw = (w: string): string => {
    switch (int(4)) {
      case 0: return w.toUpperCase();
      case 1: return w;
      case 2: return w[0].toUpperCase() + w.slice(1);
      default: return w.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
    }
  };
  const join = (p: string[]): string => p.reduce((s, x, i) => {
    if (i === 0) return x;
    const tight = (PUNC.has(p[i - 1]) || PUNC.has(x)) && rnd() < 0.5;
    return s + (tight ? '' : pick([' ', ' ', ' ', '  ', '\n', '\t'])) + x;
  }, '');

  // A tree is pieces plus the precedence level it parses at (formulaParse.ts):
  // or 0, and 1, not 2, comparison and IN 3, additive 4, multiplicative 5, unary 6, primary 7.
  type Node = { p: string[]; lvl: number };
  // A child that binds looser than its slot is parenthesised, except one time in ten (a
  // precedence clash the parser must reject or read its own way); any child, one time in twenty.
  const slot = (n: Node, min: number): string[] => ((n.lvl < min && rnd() < 0.9) || rnd() < 0.05 ? ['(', ...n.p, ')'] : n.p);
  const leaf = (): Node => {
    const r = int(10);
    const x = r < 5 ? pick(COLS) : r < 9 ? pick(LITS) : kw(pick(WORD_LITS));
    return { p: [x], lvl: x[0] === '-' ? 6 : 7 };
  };
  const expr = (d: number, top = false): string[] => node(d, top).p;
  const args = (d: number, n: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < n; i += 1) {
      if (i) out.push(',');
      out.push(...expr(d));
    }
    return out;
  };
  const call = (name: string, d: number, arity: number): string[] => [kw(name), '(', ...args(d, arity), ')'];
  const ifThen = (d: number): string[] => {
    const out = [kw('if'), ...expr(d), kw('then'), ...expr(d)];
    for (let i = int(3); i > 0; i -= 1) out.push(kw('elseif'), ...expr(d), kw('then'), ...expr(d));
    if (rnd() < 0.6) out.push(kw('else'), ...expr(d));
    return [...out, kw('end')];
  };
  const caseWhen = (d: number): string[] => {
    const out = [kw('case'), ...expr(d)];
    for (let i = 1 + int(3); i > 0; i -= 1) out.push(kw('when'), ...expr(d), kw('then'), ...expr(d));
    if (rnd() < 0.5) out.push(kw('else'), ...expr(d));
    return [...out, kw('end')];
  };
  const lod = (d: number): string[] => {
    const dims: string[] = [];
    for (let i = int(3); i > 0; i -= 1) dims.push(...(dims.length ? [','] : []), pick(DIMS));
    return ['{', kw(pick(KINDS)), ...dims, ':', kw(pick(AGGS)), '(', ...expr(d), ')', '}'];
  };

  // A tree of depth ≤ d, well-formed as built, give or take a clash (and `IF (` still reads as
  // the call form). The top of a tree is never a bare leaf: there are only a few dozen of those.
  function node(d: number, top = false): Node {
    if (d <= 0 || (!top && rnd() < 0.2)) return leaf();
    const e = (min: number): string[] => slot(node(d - 1), min);
    switch (int(12)) {
      case 0: {
        const op = pick(ARITH);
        const lvl = op === '+' || op === '-' ? 4 : 5;
        return { p: [...e(lvl), op, ...e(lvl + 1)], lvl };
      }
      case 1: return { p: [...e(3), pick(CMP), ...e(4)], lvl: 3 };
      case 2: {
        const w = pick(['and', 'or']);
        const lvl = w === 'and' ? 1 : 0;
        return { p: [...e(lvl), kw(w), ...e(lvl + 1)], lvl };
      }
      case 3: return { p: [kw('not'), ...e(2)], lvl: 2 };
      case 4: return { p: [pick(['-', '+']), ...e(6)], lvl: 6 };
      case 5: return { p: ['(', ...expr(d - 1), ')'], lvl: 7 };
      case 6: {
        const inList = [...e(4), kw('in'), '(', ...args(d - 1, int(4)), ')'];
        return { p: rnd() < 0.3 ? [...inList, pick(CMP), kw(pick(['true', 'false']))] : inList, lvl: 3 };
      }
      case 7: return { p: ifThen(d - 1), lvl: 7 };
      case 8: return { p: caseWhen(d - 1), lvl: 7 };
      case 9:
      case 10: return { p: call(pick(CORPUS_FUNCTIONS), d - 1, int(5)), lvl: 7 };
      default: return { p: lod(d - 1), lvl: 7 };
    }
  }

  function malformed(): string {
    const p = expr(3, true);
    const at = 1 + int(Math.max(1, p.length - 1));
    switch (int(5)) {
      case 0: return join(p.slice(0, at)); // cut at a piece
      case 1: return join([...p.slice(0, at), pick(STRAY), ...p.slice(at)]);
      case 2: return join([...p.slice(0, at), pick(BAD_CHARS), ...p.slice(at)]);
      case 3: return join(rnd() < 0.5 ? [kw(pick(UNKNOWN)), '(', ...p, ')'] : [...p, pick(ARITH), kw(pick(UNKNOWN)), '(', ')']);
      default: return join([...p.slice(0, at), pick(UNCLOSED), ...p.slice(at)]);
    }
  }

  return {
    /** Every frozen function name with 0 to 4 arguments. */
    perFunction: (): string[] => CORPUS_FUNCTIONS.flatMap((f) => [0, 1, 2, 3, 4].map((n) => join(call(f, 2, n)))),
    malformed,
    wellFormed: (): string => join(expr(4, true)),
  };
}

/** The corpus: the same 5,000 strings on every run. */
export function corpus(): string[] {
  const g = generator(mulberry32(CORPUS_SEED));
  const out = [...FIXED_CASES, ...g.perFunction()];
  for (let i = 0; i < MALFORMED; i += 1) out.push(g.malformed());
  while (out.length < CORPUS_SIZE) out.push(g.wellFormed());
  return out;
}

// ── The recorder ─────────────────────────────────────────────────────────────

export interface Answer {
  expr: string;
  ok: boolean;
  error?: string;
  at?: SourceSpan;
  refs?: string[];
  cost?: number;
  lods?: Omit<LodSpec, 'arg'>[];
  /** `evaluate` per row, every `@lod:<i>` slot set to 100 + i. */
  values?: FValue[];
  /** `evaluateTable` over the rows, LODs filled: only when there is one. */
  table?: FValue[];
}

function answer(expr: string): Answer {
  const res = compile(expr);
  if (!res.ok) return res.at ? { expr, ok: false, error: res.error, at: res.at } : { expr, ok: false, error: res.error };
  const fn = res.fn;
  const a: Answer = {
    expr,
    ok: true,
    refs: fn.refs,
    cost: fn.cost,
    lods: fn.lods.map(({ arg: _arg, ...spec }) => spec),
    values: CORPUS_ROWS.map((_r, i) => fn.evaluate(corpusRow(i, fn.lods.length))),
  };
  if (fn.lods.length) a.table = evaluateTable(fn, CORPUS_COLUMNS, CORPUS_ROWS);
  return a;
}

export function answers(exprs: string[] = corpus()): { version: 1; rows: Cell[][]; entries: Answer[] } {
  return { version: 1, rows: CORPUS_ROWS, entries: exprs.map(answer) };
}
