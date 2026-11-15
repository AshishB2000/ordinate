// DuckDB parse-tree EXPRESSIONS → the closed IR (docs/live-data/01-live-sql.md, "What the IR allows
// (F1)") — PURE.
//
// Each node is checked against ./shapes.ts first (its shape known, every key classified, every
// defaulted key at its default), then translated by class. Kinds are DuckDB's over the view: a
// number is a DOUBLE (F-D5), a date a DATE, `date_trunc` a TIMESTAMP (`ts`), a condition `bool`,
// which is never a value. Every literal becomes a bound parameter typed from its context (F-D4): a
// text literal met by a date binds as a DATE, and must be an ISO day. Integers the grammar needs
// as text (frame bounds, lag/lead offsets) are read here as numbers and printed through `sqlInt`.

import type { DatePart, TruncUnit } from '../dialect';
import type { AggFn, Expr, Frame, Order, Ty, WinFn } from './ir';
import { FUNCTIONS, isNode, shapeProblem } from './shapes';
import type { Scope, Tx, Typed } from './scope';
import { MAX_DEPTH, coerce, construct, fail, lookup, mixed, unify } from './scope';
import * as msg from '../../liveSqlMessages';

type Node = Record<string, unknown>;

/** Where an expression sits: may it hold an aggregate, a window function; is it inside an aggregate's argument. */
export interface Place {
  agg: boolean;
  win: boolean;
}

export const NO_AGG: Place = { agg: false, win: false };

const CMP: Record<string, '=' | '<>' | '<' | '>' | '<=' | '>='> = {
  COMPARE_EQUAL: '=', COMPARE_NOTEQUAL: '<>', COMPARE_LESSTHAN: '<', COMPARE_GREATERTHAN: '>',
  COMPARE_LESSTHANOREQUALTO: '<=', COMPARE_GREATERTHANOREQUALTO: '>=',
};
const UNITS: ReadonlySet<string> = new Set<TruncUnit>(['week', 'month', 'quarter', 'year']);
const PARTS: ReadonlySet<string> = new Set<DatePart>(['year', 'month', 'day', 'quarter']);
const INTEGER_IDS: ReadonlySet<string> = new Set(['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT']);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const kids = (n: Node): unknown[] => (Array.isArray(n.children) ? n.children : []);

/** Check a node against the allow-list, refusing what it names. */
export function checked(v: unknown, shape?: string): Node {
  if (!isNode(v)) return construct('an empty expression');
  const p = shapeProblem(v, shape);
  if (p) construct(p);
  return v;
}

/** An expression in `sc`: its node checked, its depth bounded, a non-empty alias refused (only a returned column has one). */
export function expr(v: unknown, sc: Scope, at: Place, tx: Tx, aliasOk = false): Typed {
  const n = checked(v);
  if (!aliasOk && str(n.alias) !== '') construct('an alias inside an expression');
  if (++tx.depth > MAX_DEPTH) fail('depth', msg.sqlTooDeep());
  try {
    return inner(n, sc, at, tx);
  } finally {
    tx.depth -= 1;
  }
}

/** A value: anything but a condition. */
export function value(v: unknown, sc: Scope, at: Place, tx: Tx): Typed {
  const t = expr(v, sc, at, tx);
  if (t.ty === 'bool') fail('type', msg.sqlTrueFalse());
  return t;
}

/** A condition (WHERE, ON, HAVING, CASE WHEN, AND/OR/NOT). */
export function cond(v: unknown, sc: Scope, at: Place, tx: Tx): Expr {
  const t = expr(v, sc, at, tx);
  if (t.ty !== 'bool') fail('type', msg.sqlTrueFalse());
  return t.e;
}

const num = (v: unknown, sc: Scope, at: Place, tx: Tx, what: string): Expr => {
  const t = value(v, sc, at, tx);
  if (t.ty !== 'number' && t.lit !== 'number' && t.ty !== 'null') fail('type', msg.sqlNeedsNumber(what));
  return t.e;
};

const bool = (e: Expr): Typed => ({ e, ty: 'bool' });

function inner(n: Node, sc: Scope, at: Place, tx: Tx): Typed {
  const type = str(n.type);
  switch (n.class) {
    case 'COLUMN_REF': {
      const parts = Array.isArray(n.column_names) ? n.column_names.map(str) : [];
      return lookup(sc, parts, tx);
    }
    case 'CONSTANT':
      return literal(n.value);
    case 'FUNCTION':
      return call(n, sc, at, tx);
    case 'COMPARISON': {
      const op = CMP[type];
      if (!op) return construct(type === 'COMPARE_DISTINCT_FROM' || type === 'COMPARE_NOT_DISTINCT_FROM' ? 'IS DISTINCT FROM' : type);
      const l = value(n.left, sc, at, tx);
      const r = value(n.right, sc, at, tx);
      const ty = unify([l, r]);
      return bool({ k: 'cmp', op, l: coerce(l, ty).e, r: coerce(r, ty).e });
    }
    case 'CONJUNCTION': {
      if (type !== 'CONJUNCTION_AND' && type !== 'CONJUNCTION_OR') return construct(type);
      return bool({ k: type === 'CONJUNCTION_AND' ? 'and' : 'or', xs: kids(n).map((c) => cond(c, sc, at, tx)) });
    }
    case 'OPERATOR':
      return operator(n, type, sc, at, tx);
    case 'CASE': {
      const checks = Array.isArray(n.case_checks) ? n.case_checks : [];
      const whens = checks.map((c) => checked(c, 'casecheck'));
      const conds = whens.map((w) => cond(w.when_expr, sc, at, tx));
      const thens = whens.map((w) => value(w.then_expr, sc, at, tx));
      const els = value(n.else_expr, sc, at, tx);
      const ty = unify([...thens, els]);
      const e: Expr = { k: 'case', when: conds.map((c, i) => [c, coerce(thens[i], ty).e]), else: els.e.k === 'null' ? null : coerce(els, ty).e };
      return { e, ty };
    }
    case 'CAST':
      return cast(n, sc, at, tx);
    case 'BETWEEN': {
      const x = value(n.input, sc, at, tx);
      const lo = value(n.lower, sc, at, tx);
      const hi = value(n.upper, sc, at, tx);
      const ty = unify([x, lo, hi]);
      return bool({ k: 'between', x: coerce(x, ty).e, lo: coerce(lo, ty).e, hi: coerce(hi, ty).e, not: false });
    }
    case 'SUBQUERY':
      return subquery(n, sc, at, tx);
    case 'WINDOW':
      return windowCall(n, sc, at, tx);
    case 'STAR':
      return construct('*');
    default:
      return construct(str(n.class));
  }
}

function operator(n: Node, type: string, sc: Scope, at: Place, tx: Tx): Typed {
  const cs = kids(n);
  switch (type) {
    case 'OPERATOR_NOT':
      if (cs.length !== 1) return construct('NOT');
      return bool({ k: 'not', x: cond(cs[0], sc, at, tx) });
    case 'OPERATOR_IS_NULL':
    case 'OPERATOR_IS_NOT_NULL':
      if (cs.length !== 1) return construct('IS NULL');
      return bool({ k: 'isnull', x: value(cs[0], sc, at, tx).e, not: type === 'OPERATOR_IS_NOT_NULL' });
    case 'COMPARE_IN':
    case 'COMPARE_NOT_IN': {
      const all = cs.map((c) => value(c, sc, at, tx));
      if (all.length < 2) return construct('IN ()');
      const ty = unify(all);
      const [x, ...list] = all.map((t) => coerce(t, ty).e);
      return bool({ k: 'in', x, list, not: type === 'COMPARE_NOT_IN' });
    }
    case 'OPERATOR_COALESCE': {
      const all = cs.map((c) => value(c, sc, at, tx));
      const ty = unify(all);
      return { e: { k: 'coalesce', xs: all.map((t) => coerce(t, ty).e) }, ty };
    }
    default:
      return construct(type);
  }
}

/** A constant: a bound parameter whose kind its context may still settle (`lit`), or NULL. */
export function literal(v: unknown): Typed {
  const val = checked(v, 'value');
  if (val.is_null === true) return { e: { k: 'null' }, ty: 'null' };
  const lt = checked(val.type, 'logicaltype');
  const id = str(lt.id);
  const x = val.value;
  if (id === 'VARCHAR' && typeof x === 'string') return { e: { k: 'param', ty: 'text', v: x }, ty: 'text', lit: 'text' };
  let n: number | null = null;
  if (INTEGER_IDS.has(id) && lt.type_info === null && typeof x === 'number' && Number.isSafeInteger(x)) n = x;
  else if (id === 'DOUBLE' && lt.type_info === null && typeof x === 'number' && Number.isFinite(x)) n = x;
  else if (id === 'DECIMAL' && typeof x === 'number' && Number.isSafeInteger(x)) {
    const info = checked(lt.type_info, 'typeinfo:DECIMAL_TYPE_INFO');
    const scale = info.scale;
    // The decimal TEXT, parsed once: the double nearest the literal written, as DuckDB casts it.
    if (typeof scale === 'number' && Number.isInteger(scale) && scale >= 0 && scale <= 38) n = Number(`${x}e-${scale}`);
  } else if (INTEGER_IDS.has(id) || id === 'DOUBLE' || id === 'DECIMAL' || id === 'HUGEINT' || id === 'UBIGINT') {
    return fail('number', msg.sqlBadNumber());
  }
  if (n === null || !Number.isFinite(n)) return construct(id === '' ? 'a constant' : `a ${id} constant`);
  return { e: { k: 'param', ty: 'number', v: Object.is(n, -0) ? 0 : n }, ty: 'number', lit: 'number' };
}

/** A whole number ≥ 1 written in the statement — LIMIT, a frame bound, a lag/lead offset. */
export function whole(v: unknown): number {
  const t = isNode(v) && v.class === 'CONSTANT' ? literal(checked(v).value) : null;
  if (!t || t.e.k !== 'param' || t.e.ty !== 'number' || !Number.isSafeInteger(t.e.v) || (t.e.v as number) < 1) return fail('whole', msg.sqlWholeNumber());
  return t.e.v as number;
}

function cast(n: Node, sc: Scope, at: Place, tx: Tx): Typed {
  const lt = checked(n.cast_type, 'logicaltype');
  const id = str(lt.id);
  if (lt.type_info !== null) return construct(`CAST AS ${id}`);
  const to = id === 'DOUBLE' ? 'number' : id === 'VARCHAR' ? 'text' : id === 'DATE' ? 'date' : null;
  if (!to) return construct(`CAST AS ${id}`);
  const x = value(n.child, sc, at, tx);
  if (x.ty === 'null') return { e: x.e, ty: to };
  if (x.lit) {
    // A literal cast is the literal itself, bound as its kind: DATE '2024-01-01', CAST(2 AS DOUBLE).
    if (to === 'date' || x.lit === to) return coerce(x, to);
    return mixed();
  }
  const from = x.ty as Ty;
  if (from === to || (to === 'date' && from === 'ts')) return { e: x.e, ty: to };
  // A number as text, or a timestamp as text, is spelled differently by every engine.
  if ((to === 'number' && from === 'text') || (to === 'date' && from === 'text') || (to === 'text' && from === 'date')) {
    return { e: { k: 'cast', to, from, x: x.e }, ty: to };
  }
  return construct(`CAST(${from === 'ts' ? 'date_trunc(…)' : `a ${from}`} AS ${id})`);
}

/** The function name as DuckDB parsed it, refusing a schema other than its own rewrites' `main`. */
function fnName(n: Node): string {
  const name = str(n.function_name).toLowerCase();
  const schema = str(n.schema);
  if (schema !== '' && schema !== 'main') return construct(`${schema.slice(0, 40)}.${name.slice(0, 60)}()`);
  return name;
}

function call(n: Node, sc: Scope, at: Place, tx: Tx): Typed {
  const name = fnName(n);
  const kind = FUNCTIONS.get(name);
  if (!kind) return fail('function', msg.sqlConstruct(/^[+\-*/%^|&<>=!~#@]+$/.test(name) ? name : `${name.slice(0, 60)}()`));
  const cs = kids(n);
  if (n.distinct === true && kind !== 'agg') return construct(`DISTINCT inside ${name}()`);
  switch (kind) {
    case 'agg':
      return aggregate(name, n, cs, sc, at, tx);
    case 'win':
      return construct(`${name}() without OVER`);
    case 'abs':
    case 'floor':
    case 'ceil':
      if (cs.length !== 1) return construct(`${name}() with ${cs.length} arguments`);
      return { e: { k: kind, x: num(cs[0], sc, at, tx, `${name}()`) }, ty: 'number' };
    case 'trunc': {
      const unit = cs.length === 2 ? unitOf(cs[0]) : null;
      if (!unit || !UNITS.has(unit)) return fail('unit', msg.sqlDateUnit((unit ?? '').slice(0, 30)));
      return { e: { k: 'trunc', unit: unit as TruncUnit, x: dated(cs[1], sc, at, tx, 'date_trunc') }, ty: 'ts' };
    }
    case 'part': {
      const part = cs.length === 2 ? unitOf(cs[0]) : null;
      if (!part || !PARTS.has(part)) return fail('unit', msg.sqlDateUnit((part ?? '').slice(0, 30)));
      return { e: { k: 'part', part: part as DatePart, x: dated(cs[1], sc, at, tx, 'extract') }, ty: 'number' };
    }
    case 'nullif': {
      if (cs.length !== 2) return construct('nullif() with other than two arguments');
      const a = value(cs[0], sc, at, tx);
      const b = value(cs[1], sc, at, tx);
      const ty = unify([a, b]);
      return { e: { k: 'nullif', a: coerce(a, ty).e, b: coerce(b, ty).e }, ty };
    }
    case 'like':
    case 'notLike': {
      if (cs.length !== 2) return construct('LIKE');
      const x = coerce(value(cs[0], sc, at, tx), 'text');
      const p = value(cs[1], sc, at, tx);
      if (p.lit !== 'text' || p.e.k !== 'param') return fail('like', msg.sqlLikePattern());
      if (x.ty !== 'text') return fail('type', msg.sqlNeedsText('LIKE'));
      return bool({ k: 'like', x: x.e, pattern: String(p.e.v), not: kind === 'notLike' });
    }
    default:
      return arithmetic(kind, cs, sc, at, tx);
  }
}

function arithmetic(op: '+' | '-' | '*' | '/', cs: unknown[], sc: Scope, at: Place, tx: Tx): Typed {
  if (op === '-' && cs.length === 1) return { e: { k: 'neg', x: num(cs[0], sc, at, tx, '-') }, ty: 'number' };
  if (cs.length !== 2) return construct(op);
  const l = value(cs[0], sc, at, tx);
  const r = value(cs[1], sc, at, tx);
  if (op === '-' && (l.ty === 'date' || r.ty === 'date' || l.ty === 'ts' || r.ty === 'ts')) {
    // DATE − DATE is a whole number of days in DuckDB; a TIMESTAMP − TIMESTAMP is an INTERVAL, refused.
    if (l.ty !== 'date' || r.ty !== 'date' || l.lit || r.lit) return fail('type', msg.sqlNeedsDate('-'));
    return { e: { k: 'days', l: l.e, r: r.e }, ty: 'number' };
  }
  for (const t of [l, r]) if (t.ty !== 'number' && t.ty !== 'null') fail('type', msg.sqlNeedsNumber(op));
  return { e: { k: 'arith', op, l: l.e, r: r.e }, ty: 'number' };
}

/** A date_trunc unit / date_part part: a text literal, lower-cased as DuckDB reads it. */
function unitOf(v: unknown): string | null {
  const t = isNode(v) && v.class === 'CONSTANT' ? literal(checked(v).value) : null;
  return t && t.lit === 'text' && t.e.k === 'param' ? String(t.e.v).toLowerCase() : null;
}

function dated(v: unknown, sc: Scope, at: Place, tx: Tx, what: string): Expr {
  const t = value(v, sc, at, tx);
  if (t.lit === 'text') return coerce(t, 'date').e;
  if (t.ty !== 'date' && t.ty !== 'ts' && t.ty !== 'null') fail('type', msg.sqlNeedsDate(what));
  return t.e;
}

/** An aggregate's argument may hold neither an aggregate nor a window function. */
const IN_AGG: Place = { agg: false, win: false };

function aggregate(name: string, n: Node, cs: unknown[], sc: Scope, at: Place, tx: Tx): Typed {
  if (!at.agg) return fail('aggregate', msg.sqlPlacement());
  const fn = (name === 'count_star' ? 'count' : name) as AggFn;
  const distinct = n.distinct === true;
  if (name === 'count_star' || (name === 'count' && cs.length === 0)) {
    if (cs.length !== 0 || distinct) return construct('count(*)');
    return { e: { k: 'agg', fn: 'count', distinct: false, x: null }, ty: 'number' };
  }
  if (cs.length !== 1) return construct(`${name}() with ${cs.length} arguments`);
  if (distinct && fn !== 'count') return construct(`${name}(DISTINCT …)`);
  const x = value(cs[0], sc, IN_AGG, tx);
  if ((fn === 'sum' || fn === 'avg') && x.ty !== 'number' && x.lit !== 'number') return fail('type', msg.sqlNeedsNumber(`${name}()`));
  const ty: Ty = fn === 'count' || fn === 'sum' || fn === 'avg' ? 'number' : x.ty === 'null' ? 'text' : (x.ty as Ty);
  return { e: { k: 'agg', fn, distinct, x: x.e }, ty };
}

// ── Windows ──────────────────────────────────────────────────────────────────

const RANKS: ReadonlySet<string> = new Set(['row_number', 'rank', 'dense_rank']);
const SHIFTS: ReadonlySet<string> = new Set(['lag', 'lead']);

/** The frame DuckDB parsed: null for the default; ROWS bounds otherwise (RANGE and GROUPS refused). */
function frameOf(n: Node): Frame | null {
  const start = str(n.start);
  const end = str(n.end);
  if (start === 'UNBOUNDED_PRECEDING' && end === 'CURRENT_ROW_RANGE' && n.start_expr === null && n.end_expr === null) return null;
  if (start === 'UNBOUNDED_PRECEDING' && end === 'UNBOUNDED_FOLLOWING') return { start: null, end: null };
  const bound = (b: string, e: unknown, first: boolean): number | null => {
    if (b === 'CURRENT_ROW_ROWS') return 0;
    if (b === 'EXPR_PRECEDING_ROWS') return -whole(e);
    if (b === 'EXPR_FOLLOWING_ROWS') return whole(e);
    if (first && b === 'UNBOUNDED_PRECEDING') return null;
    if (!first && b === 'UNBOUNDED_FOLLOWING') return null;
    return construct(/RANGE/.test(b) ? 'RANGE in a window frame' : /GROUPS/.test(b) ? 'GROUPS in a window frame' : b);
  };
  const f = { start: bound(start, n.start_expr, true), end: bound(end, n.end_expr, false) };
  if (f.start === null ? false : f.end !== null && f.start > f.end) construct('a window frame that ends before it starts');
  return f;
}

/** ORDER BY items (a statement's or a window's): the direction, and DuckDB's default null order (last) made explicit. */
export function orders(list: unknown, each: (e: unknown) => Expr): Order[] {
  return (Array.isArray(list) ? list : []).map((o) => {
    const node = checked(o, 'order');
    const dir = str(node.type);
    if (dir !== 'ASCENDING' && dir !== 'DESCENDING' && dir !== 'ORDER_DEFAULT') construct(`ORDER BY ${dir}`);
    const nulls = str(node.null_order);
    if (nulls !== 'ORDER_DEFAULT' && nulls !== 'NULLS FIRST' && nulls !== 'NULLS LAST' && nulls !== 'NULLS_FIRST' && nulls !== 'NULLS_LAST') construct(nulls);
    return { e: each(node.expression), desc: dir === 'DESCENDING', nullsFirst: /FIRST/.test(nulls) };
  });
}

function windowCall(n: Node, sc: Scope, at: Place, tx: Tx): Typed {
  if (!at.win) return fail('window', msg.sqlPlacement());
  const name = str(n.function_name).toLowerCase();
  const kind = FUNCTIONS.get(name);
  if (kind !== 'agg' && kind !== 'win') return fail('function', msg.sqlConstruct(`${name.slice(0, 60)}() OVER`));
  const cs = kids(n);
  // Inside OVER: the partition and order may read the group's aggregates (a ranked GROUP BY), never another window.
  const within: Place = { agg: at.agg, win: false };
  const part = (Array.isArray(n.partitions) ? n.partitions : []).map((p) => value(p, sc, within, tx).e);
  const order = orders(n.orders, (e) => value(e, sc, within, tx).e);
  const frame = frameOf(n);
  if (kind === 'agg') {
    const a = aggregate(name, n, cs, sc, { agg: true, win: false }, tx);
    if (a.e.k !== 'agg') return construct(name);
    return { e: { k: 'win', fn: a.e.fn, x: a.e.x, offset: null, part, order, frame }, ty: a.ty };
  }
  // A frame changes first_value / last_value only; on a rank or a shift every engine ignores or refuses it.
  if (frame && (RANKS.has(name) || SHIFTS.has(name))) construct(`a window frame on ${name}()`);
  let x: Typed | null = null;
  let offset: number | null = null;
  if (RANKS.has(name)) {
    if (cs.length !== 0 || n.offset_expr !== null) return construct(`${name}() with arguments`);
  } else {
    if (cs.length !== 1) return construct(`${name}() with ${cs.length} arguments`);
    x = value(cs[0], sc, within, tx);
    if (SHIFTS.has(name)) offset = n.offset_expr === null ? null : whole(n.offset_expr);
    else if (n.offset_expr !== null) return construct(`${name}() with an offset`);
  }
  const ty: Ty = x === null ? 'number' : x.ty === 'null' ? 'text' : (x.ty as Ty);
  return { e: { k: 'win', fn: name as WinFn, x: x ? x.e : null, offset, part, order, frame }, ty };
}

// ── Subqueries ───────────────────────────────────────────────────────────────

function subquery(n: Node, sc: Scope, at: Place, tx: Tx): Typed {
  const kind = str(n.subquery_type);
  const corr = { hit: false };
  const sub = (): ReturnType<Tx['query']> => {
    const st = checked(n.subquery, 'statement');
    return tx.query(st.node, sc.ctes, sc, corr);
  };
  if (kind === 'EXISTS' && n.child === null) {
    const q = sub();
    return bool({ k: 'exists', q: q.q, not: false, corr: corr.hit });
  }
  if (kind === 'SCALAR' && n.child === null) {
    const q = sub();
    if (q.cols.length !== 1) return fail('columns', msg.sqlColumns());
    return { e: { k: 'scalar', q: q.q, corr: corr.hit }, ty: q.cols[0].ty === 'null' ? 'text' : q.cols[0].ty };
  }
  if (kind === 'ANY' && n.comparison_type === 'COMPARE_EQUAL') {
    const x = value(n.child, sc, at, tx);
    const q = sub();
    if (q.cols.length !== 1) return fail('columns', msg.sqlColumns());
    const col: Typed = { e: { k: 'null' }, ty: q.cols[0].ty };
    const ty = unify([x, col]);
    return bool({ k: 'inq', x: coerce(x, ty).e, q: q.q, not: false, corr: corr.hit });
  }
  return construct(kind === 'ANY' ? 'ANY / ALL (subquery)' : `a ${kind} subquery`);
}

