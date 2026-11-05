// Which formula functions a Live calculated field may call, and how each one is
// spelled in SQL (semantic layer part 8, step 03; docs/semantic-layer/08-engine.md
// D4–D6) — PURE.
//
// The table is keyed by EVERY name in formulaEval's FUNCTIONS (scripts/test-formulaSql
// holds the two key sets equal), so a function added to the formula language is
// refused on Live until someone spells it here and the differential holds it to
// evaluate(). One list for every dialect: a dataset that moves connection keeps working.

import type { SqlFormulaBuilder, SqlTerm } from './formulaSql';
import type { DatePart } from './dialect';
import { likeAffix } from './dialect';
import { calcDatediffPart, calcNotLiteral } from '../formulaSqlMessages';

/** Why a function is refused on Live — each reason is one sentence in ./formulaSqlMessages.ts. */
export type LiveFnReason = 'math' | 'characters' | 'casing' | 'notMeasured' | 'regex' | 'dates' | 'clock' | 'conversion';
export type LiveFn = { v1: true; arity: readonly [number, number] } | { v1: false; reason: LiveFnReason };

const ANY = Infinity;

/** The v1 functions and how many arguments each takes on Live. */
const V1: Record<string, readonly [number, number]> = {
  abs: [1, 1], sign: [1, 1], floor: [1, 1], ceil: [1, 1], ceiling: [1, 1], sqrt: [1, 1], square: [1, 1],
  round: [1, 2], min: [1, ANY], max: [1, ANY],
  trim: [1, 1], contains: [2, 2], startswith: [2, 2], endswith: [2, 2], concat: [1, ANY],
  isnull: [1, 1], ifnull: [2, 2], coalesce: [1, ANY], zn: [1, 1], if: [3, 3], iif: [3, 4],
  year: [1, 1], month: [1, 1], day: [1, 1], quarter: [1, 1], datediff: [3, 3],
};

const REFUSED: Record<LiveFnReason, readonly string[]> = {
  math: ['power', 'exp', 'ln', 'log', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'cot', 'pi', 'degrees', 'radians', 'distance_km'],
  characters: ['len', 'left', 'right', 'mid', 'find', 'findnth', 'split', 'ascii', 'char', 'space', 'proper'],
  // DuckDB and JS disagree on ß, İ and a final Σ (the pin in test-formulaSqlDiff); extracts keep both.
  casing: ['lower', 'upper'],
  notMeasured: ['replace', 'ltrim', 'rtrim', 'div'],
  regex: ['regexp_match', 'regexp_extract', 'regexp_extract_nth', 'regexp_replace'],
  dates: ['date', 'datetime', 'dateadd', 'datetrunc', 'makedate', 'maketime', 'makedatetime', 'datepart', 'datename',
    'week', 'isoweek', 'isoyear', 'isoquarter', 'isoweekday', 'isdate'],
  clock: ['today', 'now'],
  conversion: ['int', 'float', 'str'],
};

function table(): Record<string, LiveFn> {
  const out: Record<string, LiveFn> = {};
  for (const [name, arity] of Object.entries(V1)) out[name] = { v1: true, arity };
  for (const [reason, names] of Object.entries(REFUSED) as [LiveFnReason, readonly string[]][]) {
    for (const name of names) out[name] = { v1: false, reason };
  }
  return out;
}

export const LIVE_FUNCTIONS: Readonly<Record<string, LiveFn>> = Object.freeze(table());
export const V1_FUNCTIONS: readonly string[] = Object.freeze(Object.keys(V1));

/** A function's Live entry by its OWN name only (never one Object.prototype lends, as formulaParse checks). */
export function liveFn(name: string): LiveFn | undefined {
  return Object.hasOwn(LIVE_FUNCTIONS, name) ? LIVE_FUNCTIONS[name] : undefined;
}

// ── The spellings (D4, D5): one per v1 function but round, which is the builder's own (a negative
// control overrides it). `b` checks types and refuses; every value is bound through it. ──

/** `b` the builder, `a` the built arguments (their count already checked), `what` the name as `round()`. */
type Spell = (b: SqlFormulaBuilder, a: SqlTerm[], at: number, what: string) => SqlTerm;

const number1 = (f: (b: SqlFormulaBuilder, x: string) => string): Spell =>
  (b, a, at, what) => ({ sql: f(b, b.need(a[0], 'number', what, at).sql), type: 'number' });

const datePart1 = (part: DatePart): Spell =>
  (b, a, at, what) => ({ sql: b.d.toDouble(b.d.datePart(b.need(a[0], 'date', what, at).sql, part)), type: 'number' });

/**
 * min / max: JS skips nulls, and a tie keeps the first. Not LEAST / GREATEST: they treat NULL differently
 * across engines. Not a left fold of CASEs either: each step repeats the one before, so it grows 4× per
 * argument. The first argument that is at most (`<=`) every other non-null one, in order, is JS's answer.
 */
const pick = (op: '<=' | '>='): Spell => (b, a, at, what) => {
  const xs = a.map((t) => b.need(t, 'number', what, at).sql);
  if (xs.length === 1) return { sql: xs[0], type: 'number' };
  let sql = '(CASE';
  xs.forEach((x, i) => {
    const rest = xs.filter((_y, j) => j !== i).map((y) => ` AND (${y} IS NULL OR ${x} ${op} ${y})`).join('');
    sql = b.out({ sql: `${sql} WHEN ${x} IS NOT NULL${rest} THEN ${x}` }, at).sql; // stops at the cap, not after it
  });
  return { sql: `${sql} END)`, type: 'number' };
};

/** contains / startswith / endswith: a needle the formula wrote, as a LIKE pattern. No coalesce: JS gives null for a null text. */
const like = (where: 'contains' | 'starts' | 'ends'): Spell => (b, a, at, what) => {
  const x = b.need(a[0], 'text', what, at).sql;
  const needle = a[1];
  if (needle.literal && needle.type === 'null') return { sql: 'NULL', type: 'null' };
  if (!needle.literal || needle.type !== 'text') return b.fail('notLiteral', calcNotLiteral(what), at);
  const p = b.c.b.bind('text', likeAffix(String(needle.literal.value), b.d.likeEscape, where));
  return { sql: `(${b.d.like(x, p)})`, type: 'boolean' };
};

const DIFF_PARTS: ReadonlySet<string> = new Set(['day', 'month', 'quarter', 'year']);

export const SPELL: Readonly<Record<string, Spell>> = {
  abs: number1((b, x) => b.d.toDouble(`abs(${x})`)),
  sign: number1((b, x) => b.d.toDouble(`sign(${x})`)),
  floor: number1((b, x) => b.d.floor(x)),
  ceil: number1((b, x) => b.d.ceil(x)),
  ceiling: number1((b, x) => b.d.ceil(x)),
  // JS gives null for a negative's root; BigQuery raises.
  sqrt: number1((_b, x) => `(CASE WHEN ${x} >= 0 THEN sqrt(${x}) END)`),
  square: number1((_b, x) => `(${x} * ${x})`),
  min: pick('<='),
  max: pick('>='),
  trim: (b, a, at, what) => ({ sql: b.d.trimJs(b.need(a[0], 'text', what, at).sql, b.c.b), type: 'text' }),
  contains: like('contains'),
  startswith: like('starts'),
  endswith: like('ends'),
  // JS reads a null as ''. (Past 1,000,000 characters JS gives null and SQL does not: a named pin.)
  concat: (b, a, at, what) => ({ sql: `(${a.map((t) => `COALESCE(${b.need(t, 'text', what, at).sql}, '')`).join(' || ')})`, type: 'text' }),
  isnull: (_b, a) => ({ sql: `(${a[0].sql} IS NULL)`, type: 'boolean' }),
  ifnull: (b, a, at, what) => ({ ...b.unify(a, what, at), sql: `COALESCE(${a[0].sql}, ${a[1].sql})` }),
  coalesce: (b, a, at, what) => (a.length === 1 ? a[0] : { ...b.unify(a, what, at), sql: `COALESCE(${a.map((t) => t.sql).join(', ')})` }),
  zn: (b, a, at, what) => ({ sql: `COALESCE(${b.need(a[0], 'number', what, at).sql}, 0)`, type: 'number' }),
  if: (b, a, at, what) => b.branch(what, [{ test: a[0], then: a[1] }], a[2], at),
  iif: (b, a, at, what) => b.branch(what, [{ test: a[0], then: a[1] }], a[2], at, a[3]),
  year: datePart1('year'),
  month: datePart1('month'),
  day: datePart1('day'),
  quarter: datePart1('quarter'),
  // Tableau's boundary crossings, as JS dateDiff counts them: days from epoch days, the rest from parts.
  datediff: (b, a, at, what) => {
    const p = a[0].literal?.value;
    const part = typeof p === 'string' ? p.trim().toLowerCase() : '';
    if (!DIFF_PARTS.has(part)) b.fail('datediffPart', calcDatediffPart(), at);
    const d = b.d;
    const x = b.need(a[1], 'date', what, at).sql;
    const y = b.need(a[2], 'date', what, at).sql;
    if (part === 'day') return { sql: d.toDouble(`(${d.epochDay(y)} - ${d.epochDay(x)})`), type: 'number' };
    const years = `(${d.datePart(y, 'year')} - ${d.datePart(x, 'year')})`;
    if (part === 'year') return { sql: d.toDouble(years), type: 'number' };
    const sub = part === 'month' ? 'month' : 'quarter';
    return { sql: d.toDouble(`(${years} * ${sub === 'month' ? 12 : 4} + (${d.datePart(y, sub)} - ${d.datePart(x, sub)}))`), type: 'number' };
  },
};
