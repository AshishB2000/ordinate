// The formula's SQL back end (semantic layer part 8, step 03; docs/semantic-layer/08-engine.md
// D2–D6, D8) — PURE. The same parse as `compile()` (formulaParse.parseTokens), built into ONE SQL
// expression per dialect with a static type, holding the JS evaluator's semantics (D5): what the
// JS builder computes for a row, this computes in the warehouse, and test-formulaSqlDiff holds the
// two to `Object.is` row by row. What it cannot hold is refused with a sentence and the span of
// the token it is about, at save.
//
//   - Columns enter as a copy stores them (D3): a number finite or NULL, text with '' as NULL, a
//     date as a DATE. The result is projected as a copy stores it, at the projection only.
//   - Every value a formula writes is BOUND (ParamSink). Identifiers are quoted by the dialect,
//     function names pick fixed spellings (./formulaSqlFunctions.ts), and TRUE, FALSE and NULL
//     are keywords. The compiler's own constants ('', 0, 0.5, 'true') are text it writes itself.
//   - Never ROUND, never LEAST / GREATEST, never a bare `/` (D5); each has a negative control.

import type { FValue, SourceSpan } from '../../formula/formula';
import { spanOf } from '../../formula/formula';
import { FormulaError, tokenize, type Tok } from '../../formula/formulaTokens';
import { parseTokens } from '../../formula/formulaParse';
import type { ArithOp, CompareOp, FormulaBuilder, LodParts } from '../../formula/formulaBuilder';
import type { LiveCalc, LiveCalcType } from '../../data/liveCalcs';
import * as m from '../formulaSqlMessages';
import { liveUnknownColumn } from '../liveRefusals';
import type { LiveColumn } from './liveSpec';
import { columnOf } from './liveSpec';
import type { SqlDialect } from './dialect';
import { isTextSourceType } from './dialect';
import { ParamSink, hasNul } from './sqlParams';
import { colRef, dateOf, numberOf, textOf } from './compileFilter';
import { dialectFor } from './dialects';
import { SPELL, liveFn } from './formulaSqlFunctions';

export type CalcValueType = 'number' | 'text' | 'date' | 'boolean' | 'null';
/** A built piece of SQL. `null` typed means always NULL. `literal` is set on a value the formula wrote. */
export interface SqlTerm { sql: string; type: CalcValueType; held?: 'date' | 'timestamp'; literal?: { value: FValue } }
export type CalcRefusalCode = 'syntax' | 'function' | 'mod' | 'lod' | 'param' | 'unknownColumn' | 'laterCalc' | 'types' | 'notBoolean'
  | 'notLiteral' | 'arity' | 'dateColumn' | 'dateResult' | 'timestampCompare' | 'roundDigits' | 'datediffPart' | 'tooLong';
export interface CalcRefusal { ok: false; code: CalcRefusalCode; error: string; at?: SourceSpan }
/** `later`: the calcs after this one, so a reference to one says so (absent: it reads as unknown). */
export interface CalcCtx { d: SqlDialect; b: ParamSink; columns: LiveColumn[]; earlier: readonly LiveCalc[]; later?: readonly LiveCalc[] }

/** The longest SQL one formula may build. CASE spellings repeat their operands, so nesting multiplies: this stops it early. */
export const MAX_CALC_SQL = 256 * 1024;

/** A refusal raised while building: a FormulaError at the token it is about. */
export class CalcError extends FormulaError {
  readonly code: CalcRefusalCode;
  constructor(code: CalcRefusalCode, message: string, at: number) {
    super(message);
    this.code = code;
    this.tokenIndex = at;
  }
}

type Need = 'number' | 'text' | 'date';
const NEED_MSG: Record<Need, (what: string) => string> = { number: m.calcNeedsNumber, text: m.calcNeedsText, date: m.calcNeedsDate };
const TIMESTAMP = /timestamp|datetime/i;

export class SqlFormulaBuilder implements FormulaBuilder<SqlTerm> {
  readonly c: CalcCtx;
  constructor(ctx: CalcCtx) {
    this.c = ctx;
  }

  get d(): SqlDialect {
    return this.c.d;
  }

  fail(code: CalcRefusalCode, message: string, at: number): never {
    throw new CalcError(code, message, at);
  }

  /** Every built term passes here, so no formula grows past MAX_CALC_SQL. */
  out<R extends { sql: string }>(t: R, at: number): R {
    if (t.sql.length > MAX_CALC_SQL) this.fail('tooLong', m.calcTooLong(), at);
    return t;
  }

  /** `t` as a `type` operand; a NULL becomes that type's NULL. Anything else is refused. */
  need(t: SqlTerm, type: Need, what: string, at: number): SqlTerm {
    if (t.type === type) return t;
    if (t.type !== 'null') this.fail('types', NEED_MSG[type](what), at);
    const sql = type === 'number' ? this.d.toDouble('NULL') : type === 'text' ? this.d.text('NULL') : this.d.date('NULL', false, '');
    return { sql, type, ...(type === 'date' ? { held: 'date' as const } : {}) };
  }

  /** A test: boolean (or NULL) only, null as false (JS `truthy`). Never NULL. */
  truth(t: SqlTerm, what: string, at: number): string {
    if (t.type !== 'boolean' && t.type !== 'null') this.fail('notBoolean', m.calcNotBoolean(what), at);
    return `COALESCE(${t.sql}, FALSE)`;
  }

  /** The one type of several results (NULLs aside); refused when they differ. `sql` is the caller's. */
  unify(terms: SqlTerm[], what: string, at: number): SqlTerm {
    const types = new Set(terms.map((t) => t.type).filter((t) => t !== 'null'));
    if (types.size > 1) this.fail('types', m.calcSameType(what), at);
    const type: CalcValueType = types.size ? [...types][0] : 'null';
    if (type !== 'date') return { sql: '', type };
    return { sql: '', type, held: terms.some((t) => t.held === 'timestamp') ? 'timestamp' : 'date' };
  }

  /** JS `looseEq` on two terms of one type: NULL equals only NULL. Never NULL. */
  eq(a: SqlTerm, b: SqlTerm): string {
    return `(CASE WHEN ${a.sql} IS NULL OR ${b.sql} IS NULL THEN (${a.sql} IS NULL AND ${b.sql} IS NULL) ELSE ${a.sql} = ${b.sql} END)`;
  }

  /** An item of IN or CASE WHEN: a value the formula wrote, of the subject's type. */
  private item(subject: SqlTerm, item: SqlTerm, what: string, at: number): SqlTerm {
    if (!item.literal) this.fail('notLiteral', m.calcNotLiteral(what), at);
    if (item.type !== 'null' && subject.type !== 'null' && item.type !== subject.type) this.fail('types', m.calcCompareTypes(what), at);
    return item;
  }

  private noTimestamp(terms: SqlTerm[], at: number): void {
    if (terms.some((t) => t.held === 'timestamp')) this.fail('timestampCompare', m.calcTimestampCompare(), at);
  }

  num(value: number, at: number): SqlTerm {
    if (!Number.isFinite(value)) this.fail('types', m.calcNumberTooLarge(), at);
    return { sql: this.c.b.bind('number', value), type: 'number', literal: { value } };
  }

  str(value: string): SqlTerm {
    return { sql: this.c.b.bind('text', value), type: 'text', literal: { value } };
  }

  bool(value: boolean): SqlTerm {
    return { sql: value ? 'TRUE' : 'FALSE', type: 'boolean', literal: { value } };
  }

  nul(): SqlTerm {
    return { sql: 'NULL', type: 'null', literal: { value: null } };
  }

  param(at: number): SqlTerm {
    return this.fail('param', m.calcParamRefused(), at);
  }

  lod(_parts: LodParts<SqlTerm>, at: number): SqlTerm {
    return this.fail('lod', m.calcLodRefused(), at);
  }

  col(name: string, at: number): SqlTerm {
    const c = this.c;
    const col = hasNul(name) ? null : columnOf(c.columns, name);
    if (col?.type === 'number') return { sql: numberOf(c, col), type: 'number' };
    if (col?.type === 'date') {
      if (isTextSourceType(col.sourceType)) this.fail('dateColumn', m.calcDateColumn(name), at);
      return { sql: dateOf(c, col), type: 'date', held: TIMESTAMP.test(col.sourceType ?? '') ? 'timestamp' : 'date' };
    }
    if (col) return { sql: `NULLIF(${textOf(c, col)}, '')`, type: 'text' };
    // An earlier calc is a column of the layer below, already projected as a copy stores it.
    const calc = c.earlier.find((x) => x.name === name);
    if (calc) return { sql: colRef(c, { name, type: calc.type }), type: calc.type };
    if (c.later?.some((x) => x.name === name)) this.fail('laterCalc', m.calcLaterCalc(name), at);
    return this.fail('unknownColumn', liveUnknownColumn(name), at);
  }

  neg(e: SqlTerm, at: number): SqlTerm {
    // Folded into the literal, so round(x, -2) and IN (-1) still see a value the formula wrote.
    if (e.literal && e.type === 'null') return e;
    if (e.literal && e.type === 'number') return this.num(-(e.literal.value as number), at);
    return this.out({ sql: `(- ${this.need(e, 'number', '-', at).sql})`, type: 'number' }, at);
  }

  arith(op: ArithOp, l: SqlTerm, r: SqlTerm, at: number): SqlTerm {
    if (op === '%') this.fail('mod', m.calcModRefused(), at);
    const a = this.need(l, 'number', op, at).sql;
    const b = this.need(r, 'number', op, at).sql;
    // JS gives null for x / 0; BigQuery and Databricks (ANSI) raise.
    return this.out({ sql: op === '/' ? `(${a} / NULLIF(${b}, 0))` : `(${a} ${op} ${b})`, type: 'number' }, at);
  }

  compare(op: CompareOp, l: SqlTerm, r: SqlTerm, at: number): SqlTerm {
    // A copy holds a timestamp's text, Live its day: they would compare different things (pin 7).
    this.noTimestamp([l, r], at);
    if (l.type !== 'null' && r.type !== 'null' && l.type !== r.type) this.fail('types', m.calcCompareTypes(op), at);
    const type = l.type === 'null' ? r.type : l.type;
    if (op === '=' || op === '==') return this.out({ sql: this.eq(l, r), type: 'boolean' }, at);
    if (op === '!=') return this.out({ sql: `(NOT ${this.eq(l, r)})`, type: 'boolean' }, at);
    if (type === 'boolean') this.fail('types', m.calcCompareTypes(op), at);
    // JS compares text with null as '': below everything, exact.
    if (type === 'text') return this.out({ sql: `(COALESCE(${l.sql}, '') ${op} COALESCE(${r.sql}, ''))`, type: 'boolean' }, at);
    return this.out({ sql: this.ordered(op, l.sql, r.sql), type: 'boolean' }, at);
  }

  /** Numbers and DATE-held dates: JS compares a null as '', below everything, so the NULL branches are constants. */
  ordered(op: CompareOp, a: string, b: string): string {
    const k = (yes: boolean): string => (yes ? 'TRUE' : 'FALSE');
    const equal = op === '<=' || op === '>=';
    const below = op === '<' || op === '<=';
    return `(CASE WHEN ${a} IS NULL AND ${b} IS NULL THEN ${k(equal)} WHEN ${a} IS NULL THEN ${k(below)} WHEN ${b} IS NULL THEN ${k(!below)} ELSE ${a} ${op} ${b} END)`;
  }

  and(l: SqlTerm, r: SqlTerm, at: number): SqlTerm {
    return this.out({ sql: `(${this.truth(l, 'AND', at)} AND ${this.truth(r, 'AND', at)})`, type: 'boolean' }, at);
  }

  or(l: SqlTerm, r: SqlTerm, at: number): SqlTerm {
    return this.out({ sql: `(${this.truth(l, 'OR', at)} OR ${this.truth(r, 'OR', at)})`, type: 'boolean' }, at);
  }

  not(e: SqlTerm, at: number): SqlTerm {
    return this.out({ sql: `(NOT ${this.truth(e, 'NOT', at)})`, type: 'boolean' }, at);
  }

  inList(subject: SqlTerm, items: SqlTerm[], at: number): SqlTerm {
    this.noTimestamp([subject], at);
    const eqs = items.map((it) => this.eq(subject, this.item(subject, it, 'IN', at)));
    return this.out({ sql: eqs.length ? `(${eqs.join(' OR ')})` : 'FALSE', type: 'boolean' }, at);
  }

  ifThen(branches: { test: SqlTerm; then: SqlTerm }[], otherwise: SqlTerm | null, at: number): SqlTerm {
    return this.branch('IF', branches, otherwise, at);
  }

  /** IF / if() / iif(): the first true test's value, else `otherwise`; `unknown` when the first test is NULL (iif's 4th). */
  branch(what: string, branches: { test: SqlTerm; then: SqlTerm }[], otherwise: SqlTerm | null, at: number, unknown?: SqlTerm): SqlTerm {
    const t = this.unify([...branches.map((x) => x.then), ...(otherwise ? [otherwise] : []), ...(unknown ? [unknown] : [])], what, at);
    const whens = branches.map((x) => `WHEN ${this.truth(x.test, what, at)} THEN ${x.then.sql}`);
    if (unknown) whens.unshift(`WHEN ${branches[0].test.sql} IS NULL THEN ${unknown.sql}`);
    return this.out({ ...t, sql: `(CASE ${whens.join(' ')}${otherwise ? ` ELSE ${otherwise.sql}` : ''} END)` }, at);
  }

  caseWhen(subject: SqlTerm, whens: { val: SqlTerm; then: SqlTerm }[], otherwise: SqlTerm | null, at: number): SqlTerm {
    this.noTimestamp([subject], at);
    const t = this.unify([...whens.map((w) => w.then), ...(otherwise ? [otherwise] : [])], 'CASE', at);
    const parts = whens.map((w) => `WHEN ${this.eq(subject, this.item(subject, w.val, 'CASE', at))} THEN ${w.then.sql}`);
    return this.out({ ...t, sql: `(CASE ${parts.join(' ')}${otherwise ? ` ELSE ${otherwise.sql}` : ''} END)` }, at);
  }

  call(name: string, args: SqlTerm[], at: number): SqlTerm {
    const f = liveFn(name);
    if (!f || !f.v1) return this.fail('function', m.calcFunctionRefused(name, f ? f.reason : 'notMeasured'), at);
    if (args.length < f.arity[0] || args.length > f.arity[1]) this.fail('arity', m.calcArity(name, String(args.length)), at);
    if (name === 'round') return this.out(this.round(args[0], args[1] ?? null, at), at);
    return this.out(SPELL[name](this, args, at, `${name}()`), at);
  }

  /**
   * JS `Math.round(x * f) / f`, ties toward +∞, with f = 10^n bound from JS. Never ROUND: engines split
   * ties away from zero or to even. `n` is a whole literal in −15…15.
   */
  round(x: SqlTerm, n: SqlTerm | null, at: number): SqlTerm {
    const v = this.need(x, 'number', 'round()', at).sql;
    const digits = n === null ? 0 : n.literal && n.type === 'number' ? (n.literal.value as number) : NaN;
    if (!Number.isInteger(digits) || digits < -15 || digits > 15) this.fail('roundDigits', m.calcRoundDigits(), at);
    const f = Math.pow(10, digits);
    const y = digits === 0 ? v : `(${v} * ${this.c.b.bind('number', f)})`;
    const fl = this.d.floor(y);
    const r = `(CASE WHEN ${y} - ${fl} >= 0.5 THEN ${fl} + 1 ELSE ${fl} END)`;
    return { sql: digits === 0 ? r : `(${r} / ${this.c.b.bind('number', f)})`, type: 'number' };
  }

  /** The result, as a copy stores it (D3). A date result is refused (v1). */
  project(t: SqlTerm, at: number): { sql: string; type: LiveCalcType } {
    const e = t.sql;
    switch (t.type) {
      // −0 as 0 (a copy stores String(-0)), then finite only: NaN and ±∞ are no `e - e = 0`.
      case 'number': return this.out({ sql: `CASE WHEN ${e} = 0 THEN ${this.d.toDouble('0')} WHEN ${e} - ${e} = 0 THEN ${e} END`, type: 'number' }, at);
      case 'text': return { sql: `NULLIF(${e}, '')`, type: 'text' };
      case 'boolean': return { sql: `CASE ${e} WHEN TRUE THEN 'true' WHEN FALSE THEN 'false' END`, type: 'text' };
      case 'null': return { sql: this.d.text('NULL'), type: 'text' };
      default: return this.fail('dateResult', m.calcDateResult(), at);
    }
  }
}

/** `type`: as stored (a boolean is stored as text); `result`: what the formula itself gives, for the editor's badge. */
export type CalcCompiled = { ok: true; sql: string; type: LiveCalcType; result: CalcValueType; refs: string[] };

function refusalOf(e: unknown, tokens: Tok[], src: string): CalcRefusal {
  if (!(e instanceof FormulaError)) throw e; // a bug, said out loud — never a quiet refusal
  const code: CalcRefusalCode = e instanceof CalcError ? e.code : 'syntax';
  const at = e.at ?? (e.tokenIndex === undefined ? undefined : spanOf(tokens, e.tokenIndex, src));
  return at ? { ok: false, code, error: e.message, at } : { ok: false, code, error: e.message };
}

/** One formula as one projected SQL expression over `lv_src`, its values bound into `ctx.b`; or why not. */
export function compileCalcSql(expression: string, ctx: CalcCtx, B: typeof SqlFormulaBuilder = SqlFormulaBuilder): CalcCompiled | CalcRefusal {
  if (typeof expression !== 'string' || expression.trim() === '') return { ok: false, code: 'syntax', error: 'Empty expression' };
  let tokens: Tok[] = [];
  try {
    tokens = tokenize(expression);
    const b = new B(ctx);
    const { root, refs } = parseTokens(tokens, b);
    const p = b.project(root, 0);
    return { ok: true, sql: p.sql, type: p.type, result: root.type, refs };
  } catch (e) {
    return refusalOf(e, tokens, expression);
  }
}

/** The save-time verdict, dialect-free: compileCalcSql on the DuckDB dialect with a throwaway sink. */
export function checkCalc(expression: string, columns: LiveColumn[], earlier: readonly LiveCalc[], later: readonly LiveCalc[] = []):
  { ok: true; type: LiveCalcType; result: CalcValueType; refs: string[] } | CalcRefusal {
  const r = compileCalcSql(expression, { d: dialectFor('duckdb'), b: new ParamSink(), columns, earlier, later });
  return r.ok ? { ok: true, type: r.type, result: r.result, refs: r.refs } : r;
}
