// How a metric's number splits across the members of a dimension — MAIN
// PROCESS, PURE. No fs, no DuckDB.
//
// Key drivers ("why did Revenue fall?") can only decompose a number whose
// pieces ADD UP. This file reads a metric's definition and says which of two
// shapes it has, in terms of AGGREGATE OPERANDS over its dataset's columns:
//
//   additive   Σ coef · operand            sum(revenue), count(order_date),
//                                          [Revenue] − [Cost]
//   ratio      (Σ coef · op) / (Σ coef · op)   [Profit] / [Revenue],
//                                          avg(x) = sum(x) / numeric count(x)
//
// Every operand is a `sum`, a `count` (non-empty cells, text included) or an
// `ncount` (finite numeric cells — the denominator of an avg), each carrying
// the metric-level filters it is resolved under. Those filters follow
// src/ipc/metrics.ts `resolveDefinition` exactly: an aggregation written inside
// a formula takes THAT formula metric's filters; a referenced metric `[X]`
// takes X's own filters, never its parent's.
//
// Anything else — min/max, a constant offset, a product of two measures, a
// function call, a column on a related dataset — is refused with a sentence,
// because a decomposition of a number that does not add up would be a chart of
// invented contributions.
//
// The formula text is read with the ordinary tokenizer (src/formula) and a
// small recursive descent over `+ − × ÷`, parentheses, numbers, `[Metric]`
// references and `agg(column)` calls. It never evaluates anything.

import type { FilterStep } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import type { Metric, MetricDefinition } from './metrics';
import { isFormulaDefinition } from './metrics';
import type { MetricAggregation } from './metricValue';
import { tokenize } from '../formula/formulaTokens';
import type { Tok } from '../formula/formulaTokens';
import { bindFormulaText, resolveFilterParams } from './params';
import type { ParamValues } from './params';

export type OperandAgg = 'sum' | 'count' | 'ncount';

/** One aggregate the decomposition needs per member and per period. */
export interface Operand {
  column: string;
  agg: OperandAgg;
  /** Metric-level filters, params already resolved. */
  filters: FilterStep[];
}

/** Σ coef · operand[op]. Terms sorted by operand index; no zero coefficients. */
export interface Linear {
  terms: Array<{ op: number; coef: number }>;
}

export type DriverShape =
  | { kind: 'additive'; operands: Operand[]; num: Linear }
  | { kind: 'ratio'; operands: Operand[]; num: Linear; den: Linear }
  | { kind: 'none'; reason: string };

/** How deep `[A]` → `[B]` → … may go — the same bound the metric resolver uses. */
const MAX_DEPTH = 10;

class NotDecomposable extends Error {}

type Val =
  | { t: 'c'; v: number }
  | { t: 'lin'; m: Map<number, number> }
  | { t: 'ratio'; n: Map<number, number>; d: Map<number, number> };

function fail(reason: string): never {
  throw new NotDecomposable(reason);
}

function scale(m: Map<number, number>, k: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const [op, c] of m) out.set(op, c * k);
  return out;
}

function addMaps(a: Map<number, number>, b: Map<number, number>, sign: number): Map<number, number> {
  const out = new Map(a);
  for (const [op, c] of b) out.set(op, (out.get(op) ?? 0) + sign * c);
  return out;
}

function add(a: Val, b: Val, sign: 1 | -1): Val {
  if (a.t === 'c' && b.t === 'c') return { t: 'c', v: a.v + sign * b.v };
  if (a.t === 'lin' && b.t === 'lin') return { t: 'lin', m: addMaps(a.m, b.m, sign) };
  // A constant 0 is harmless; any other constant offset has no members to live in.
  if (a.t === 'lin' && b.t === 'c' && b.v === 0) return a;
  if (a.t === 'c' && a.v === 0 && b.t === 'lin') return { t: 'lin', m: scale(b.m, sign) };
  if (a.t === 'ratio' || b.t === 'ratio') fail('It adds to a ratio, and a sum of ratios does not split into members.');
  fail('It adds a constant to a measure, and a constant belongs to no member.');
}

function mul(a: Val, b: Val): Val {
  if (a.t === 'c' && b.t === 'c') return { t: 'c', v: a.v * b.v };
  if (b.t === 'c') return scaled(a, b.v);
  if (a.t === 'c') return scaled(b, a.v);
  fail('It multiplies two measures together, which does not split into members.');
}

function scaled(x: Val, k: number): Val {
  if (x.t === 'c') return { t: 'c', v: x.v * k };
  if (x.t === 'lin') return { t: 'lin', m: scale(x.m, k) };
  return { t: 'ratio', n: scale(x.n, k), d: x.d };
}

function div(a: Val, b: Val): Val {
  if (b.t === 'c') {
    if (b.v === 0) fail('It divides by zero.');
    return scaled(a, 1 / b.v);
  }
  if (a.t === 'lin' && b.t === 'lin') return { t: 'ratio', n: a.m, d: b.m };
  fail('It divides in a way that is not one sum over another.');
}

/** The shape builder: one per question, so operand numbering is stable within it. */
class Shaper {
  readonly operands: Operand[] = [];
  private readonly index = new Map<string, number>();

  constructor(
    private readonly datasetId: string,
    private readonly columns: ParsedColumn[],
    private readonly byName: Map<string, Metric>,
    private readonly params: ParamValues,
  ) {}

  operand(column: string, agg: OperandAgg, filters: FilterStep[]): number {
    const col = this.columns.find((c) => c.name === column);
    if (!col) fail(`"${column}" is not a column of this dataset.`);
    if (agg !== 'count' && col.type !== 'number') fail(`"${column}" is not a number column.`);
    const key = agg + '\u0000' + column + '\u0000' + JSON.stringify(filters);
    const seen = this.index.get(key);
    if (seen !== undefined) return seen;
    const i = this.operands.length;
    this.operands.push({ column, agg, filters });
    this.index.set(key, i);
    return i;
  }

  aggregate(column: string, aggregation: MetricAggregation, filters: FilterStep[]): Val {
    if (aggregation === 'sum') return { t: 'lin', m: new Map([[this.operand(column, 'sum', filters), 1]]) };
    if (aggregation === 'count') return { t: 'lin', m: new Map([[this.operand(column, 'count', filters), 1]]) };
    if (aggregation === 'avg') {
      return {
        t: 'ratio',
        n: new Map([[this.operand(column, 'sum', filters), 1]]),
        d: new Map([[this.operand(column, 'ncount', filters), 1]]),
      };
    }
    fail(`A ${aggregation} is one row's value, not a total that splits into members.`);
  }

  definition(def: MetricDefinition, rawFilters: FilterStep[], stack: Set<string>, depth: number): Val {
    const filters = resolveFilterParams(rawFilters, this.params).steps;
    if (!isFormulaDefinition(def)) {
      if (!def.column) fail('This metric has no column.');
      return this.aggregate(def.column, def.aggregation, filters);
    }
    if (depth > MAX_DEPTH) fail('Its formula references metrics too deeply.');
    let toks: Tok[];
    try {
      toks = tokenize(bindFormulaText(def.formula, this.params).text);
    } catch (_) {
      fail('Its formula does not parse.');
    }
    return new FormulaReader(toks, this, filters, stack, depth).read();
  }

  metric(name: string, stack: Set<string>, depth: number): Val {
    const key = name.toLowerCase();
    if (stack.has(key)) fail(`"${name}" refers back to itself.`);
    const m = this.byName.get(key);
    if (!m) fail(`There is no metric called "${name}".`);
    if (m.datasetId !== this.datasetId) fail(`"${m.name}" lives on another dataset.`);
    stack.add(key);
    try {
      return this.definition(m.definition, m.filters, stack, depth + 1);
    } finally {
      stack.delete(key);
    }
  }
}

/** `+ − × ÷` over numbers, `[Metric]`, `agg(column)` and parentheses. */
class FormulaReader {
  private pos = 0;

  constructor(
    private readonly toks: Tok[],
    private readonly shaper: Shaper,
    private readonly filters: FilterStep[],
    private readonly stack: Set<string>,
    private readonly depth: number,
  ) {}

  read(): Val {
    const v = this.expr();
    if (this.pos < this.toks.length) fail('Its formula uses something other than + − × ÷ over metrics and totals.');
    return v;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return !!t && t.kind === 'op' && ops.includes(t.value);
  }

  private isPunc(v: string): boolean {
    const t = this.peek();
    return !!t && t.kind === 'punc' && t.value === v;
  }

  private expr(): Val {
    let v = this.term();
    while (this.isOp('+', '-')) {
      const sign = this.toks[this.pos++].value === '+' ? 1 : -1;
      v = add(v, this.term(), sign);
    }
    return v;
  }

  private term(): Val {
    let v = this.unary();
    while (this.isOp('*', '/')) {
      const op = this.toks[this.pos++].value;
      const rhs = this.unary();
      v = op === '*' ? mul(v, rhs) : div(v, rhs);
    }
    return v;
  }

  private unary(): Val {
    if (this.isOp('-')) {
      this.pos += 1;
      return scaled(this.unary(), -1);
    }
    if (this.isOp('+')) {
      this.pos += 1;
      return this.unary();
    }
    return this.primary();
  }

  private primary(): Val {
    const t = this.peek();
    if (!t) fail('Its formula ends early.');
    if (t.kind === 'num') {
      this.pos += 1;
      const v = Number(t.value);
      if (!Number.isFinite(v)) fail('Its formula has a number out of range.');
      return { t: 'c', v };
    }
    if (this.isPunc('(')) {
      this.pos += 1;
      const v = this.expr();
      if (!this.isPunc(')')) fail('Its formula has an unclosed bracket.');
      this.pos += 1;
      return v;
    }
    if (t.kind === 'name' && this.toks[this.pos + 1]?.kind === 'punc' && this.toks[this.pos + 1].value === '(') {
      const fn = t.value.toLowerCase();
      const arg = this.toks[this.pos + 2];
      const close = this.toks[this.pos + 3];
      const isAgg = fn === 'sum' || fn === 'count' || fn === 'avg' || fn === 'min' || fn === 'max';
      if (!isAgg || !arg || (arg.kind !== 'name' && arg.kind !== 'col') || !close || close.kind !== 'punc' || close.value !== ')') {
        fail(`Its formula calls ${t.value}(), which does not split into members.`);
      }
      this.pos += 4;
      return this.shaper.aggregate(arg.value, fn as MetricAggregation, this.filters);
    }
    if (t.kind === 'col' || t.kind === 'name') {
      this.pos += 1;
      return this.shaper.metric(t.value, this.stack, this.depth);
    }
    fail('Its formula uses something other than + − × ÷ over metrics and totals.');
  }
}

function linear(m: Map<number, number>): Linear {
  const terms = Array.from(m.entries())
    .filter(([, c]) => c !== 0)
    .sort((a, b) => a[0] - b[0])
    .map(([op, coef]) => ({ op, coef }));
  return { terms };
}

/**
 * The shape of a metric — a saved Metric's definition, or a card's bare
 * `{column, aggregation}` (pass `filters: []`).
 *
 * `byName` is the project's metrics by LOWER-CASED name (metrics.metricsByName),
 * used to follow `[References]`. Never throws.
 */
export function metricShape(
  datasetId: string,
  columns: ParsedColumn[],
  def: MetricDefinition,
  filters: FilterStep[],
  byName: Map<string, Metric>,
  params: ParamValues = new Map(),
  selfName?: string,
): DriverShape {
  const shaper = new Shaper(datasetId, Array.isArray(columns) ? columns : [], byName, params);
  const stack = new Set<string>(selfName ? [selfName.toLowerCase()] : []);
  try {
    const v = shaper.definition(def, Array.isArray(filters) ? filters : [], stack, 0);
    if (v.t === 'c') return { kind: 'none', reason: 'This metric is a constant, so nothing drives it.' };
    const operands = shaper.operands;
    if (v.t === 'lin') {
      const num = linear(v.m);
      if (!num.terms.length) return { kind: 'none', reason: 'This metric cancels itself out.' };
      return { kind: 'additive', operands, num };
    }
    const num = linear(v.n);
    const den = linear(v.d);
    if (!den.terms.length) return { kind: 'none', reason: 'This ratio has nothing below the line.' };
    return { kind: 'ratio', operands, num, den };
  } catch (err) {
    if (err instanceof NotDecomposable) return { kind: 'none', reason: 'This metric cannot be split by member. ' + err.message };
    return { kind: 'none', reason: 'This metric cannot be split by member.' };
  }
}

/** Σ coef · values[op], left to right in operand order. A null operand makes the whole figure null. */
export function evalLinear(lin: Linear, values: Array<number | null>): number | null {
  let out = 0;
  for (const t of lin.terms) {
    const v = values[t.op];
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    out += t.coef * v;
  }
  return out;
}
