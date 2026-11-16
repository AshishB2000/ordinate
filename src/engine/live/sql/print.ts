// SQL on Live datasets, F1: the IR (./ir.ts) → ONE statement per dialect (docs/live-data/01-live-sql.md
// F-D3…F-D8) — PURE: builds strings, queries nothing.
//
//   WITH v0 AS (<view of a dataset, ./view.ts>), …, q0 AS (<a CTE or FROM subquery>), …
//   SELECT <outputs AS o_0…> FROM v0 AS t0 … ORDER BY <the model's keys>, o_0, … LIMIT 501
//
// No byte the model wrote is in the text: identifiers come only from the record, through `ident()`
// inside the view; every other name is generated — views `v<i>` and their columns `c<j>`,
// relations `q<i>` and their outputs `o<i>_<j>`, FROM instances `t<n>`, inline subqueries' outputs
// `s<n>_<j>`, the statement's outputs `o_<j>` — and every reference is qualified, so a warehouse's
// search path, case folding or alias-before-column rule cannot move one. Every value is a
// placeholder (`ParamSink`), every integer the grammar needs (LIMIT, a frame bound, an offset)
// `sqlInt` text. The rules:
//
//   F-D5  one number type: every aggregate, count and window rank through `toDouble`, every number
//         output too; `/` divides by NULLIF(r, 0) (DuckDB answers ±Infinity, which a copy's reply
//         reads as empty; Postgres raises).
//   F-D7  a date output is `isoDay` text; `d1 - d2` is `epochDay(d1) - epochDay(d2)`.
//   F-D8  the statement ends ORDER BY the model's keys, then every output, each null order explicit
//         (DuckDB's default: last), then LIMIT 501 — or the model's own LIMIT when smaller.
//
// Refused per dialect (each a named pin until its engine is verified in the nightly, F7): on
// ClickHouse a correlated subquery (pin CH1 in scripts/liveSqlPins.ts). lag/lead/first_value/
// last_value (pin CH2, lifted) print there as `lagInFrame(toNullable(x), n, NULL)` over the whole
// partition and `first_value_respect_nulls(toNullable(x))`, so past the frame is NULL, as DuckDB's.

import type { CompiledQuery } from '../sqlParams';
import { ParamSink } from '../sqlParams';
import type { CompileDialectId, SqlDialect } from '../dialect';
import { sqlInt } from '../dialect';
import { dialectFor } from '../dialects';
import type { Expr, Frame, From, LiveSqlIR, Order, Query, Select, SetOp, Ty } from './ir';
import type { ViewInput } from './view';
import { viewBody } from './view';
import type { SqlRefusal } from './scope';
import { Refused, fail } from './scope';
import type { LiveRefusal } from '../liveSpec';
import * as msg from '../../liveSqlMessages';

/** The most rows a statement returns: phase B's 500, fetched as 501 so "more" is known. */
export const LIVE_SQL_ROWS = 500;

/** The join keywords — a table so a negative control can print LEFT as INNER and watch the differential catch it. */
export const JOIN_WORDS: Record<string, string> = { inner: 'INNER JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', full: 'FULL JOIN' };

/**
 * What the printer refuses on ClickHouse (pin CH1) — a table, so the nightly's lift probe can widen it and run what it
 * holds back. `shifts` is empty since CH2 was lifted (lag/lead/first_value/last_value print in ClickHouse's own form);
 * a window function named in it is refused there again.
 */
export const OFF_CLICKHOUSE = { correlated: true, shifts: new Set<string>() };

class Printer {
  private subs = 0;
  private wraps = 0;

  constructor(readonly d: SqlDialect, readonly b: ParamSink) {}

  query(q: Query, prefix: string, fmt: readonly Ty[] | null, top: boolean): string {
    return q.k === 'select' ? this.select(q, prefix, fmt, top) : this.setOp(q, prefix, fmt, top);
  }

  private format(e: Expr, ty: Ty): string {
    const x = this.expr(e);
    if (ty === 'number') return isDouble(e) ? x : this.d.toDouble(x);
    if (ty === 'date' || ty === 'ts') return this.d.isoDay(x);
    return this.d.label(x);
  }

  /** ORDER BY: the model's keys, then (at the top, or with a LIMIT) every output not already a key; and the LIMIT. */
  private tail(order: readonly Order[], n: number, out: (i: number) => string, limit: number | null, top: boolean): string {
    if (!top && limit === null) return ''; // an inner ORDER BY with no LIMIT changes nothing: never sent
    const keys = order.map((o) => this.d.nullOrder(o.e.k === 'out' ? out(o.e.i) : this.expr(o.e), o.desc, o.nullsFirst));
    const named = new Set(order.flatMap((o) => (o.e.k === 'out' ? [o.e.i] : [])));
    for (let i = 0; i < n; i += 1) if (!named.has(i)) keys.push(this.d.nullOrder(out(i), false, false));
    const cap = top ? Math.min(limit ?? LIVE_SQL_ROWS + 1, LIVE_SQL_ROWS + 1) : (limit as number);
    return `${keys.length ? ` ORDER BY ${keys.join(', ')}` : ''} LIMIT ${sqlInt(cap)}`;
  }

  private select(s: Select, prefix: string, fmt: readonly Ty[] | null, top: boolean): string {
    const from = s.from ? ` FROM ${this.from(s.from)}` : '';
    const items = s.items.map((it, i) => `${fmt ? this.format(it.e, fmt[i]) : this.expr(it.e)} AS ${prefix}${i}`);
    const where = s.where ? ` WHERE ${this.expr(s.where)}` : '';
    // A grouped output by its alias only when it holds a value: two placeholders never match as the same
    // expression (Postgres), and the alias of a formatted output would leave its raw column ungrouped.
    const group = s.group.length ? ` GROUP BY ${s.group.map((g) => (g.k !== 'out' ? this.expr(g) : hasParam(s.items[g.i].e) ? `${prefix}${g.i}` : this.expr(s.items[g.i].e))).join(', ')}` : '';
    const having = s.having ? ` HAVING ${this.expr(s.having)}` : '';
    const tail = this.tail(s.order, s.items.length, (i) => `${prefix}${i}`, s.limit, top);
    return `SELECT ${s.distinct ? 'DISTINCT ' : ''}${items.join(', ')}${from}${where}${group}${having}${tail}`;
  }

  /** A set operation; a nested one, or one carrying ORDER BY / LIMIT, read through a derived table (ClickHouse would order its last SELECT only). */
  private setOp(s: SetOp, prefix: string, fmt: readonly Ty[] | null, top: boolean): string {
    const side = (q: Query): string => (q.k === 'select' ? this.select(q, prefix, fmt, false) : `SELECT * FROM (${this.setOp(q, prefix, fmt, false)}) AS w${this.wraps++}`);
    const body = `${side(s.l)} ${this.d.setOp(s.op)} ${side(s.r)}`;
    if (!top && s.limit === null) return body;
    const w = `w${this.wraps++}`;
    return `SELECT * FROM (${body}) AS ${w}${this.tail(s.order, s.items.length, (i) => `${w}.${prefix}${i}`, s.limit, top)}`;
  }

  private from(f: From): string {
    if (f.k === 'view') return `v${f.v} AS t${f.t}`;
    if (f.k === 'rel') return `q${f.q} AS t${f.t}`;
    return `${this.from(f.l)} ${JOIN_WORDS[f.kind]} ${this.from(f.r)} ON ${this.expr(f.on)}`;
  }

  private sub(q: Query, corr: boolean): string {
    if (corr && this.d.id === 'clickhouse' && OFF_CLICKHOUSE.correlated) fail('dialect', msg.sqlConstructOn('A subquery that reads its outer query', 'ClickHouse'));
    return this.query(q, `s${this.subs++}_`, null, false);
  }

  private order(o: Order): string {
    return this.d.nullOrder(this.expr(o.e), o.desc, o.nullsFirst);
  }

  private frame(f: Frame): string {
    const at = (n: number | null, unbounded: string): string => (n === null ? unbounded : n === 0 ? 'CURRENT ROW' : n < 0 ? `${sqlInt(-n)} PRECEDING` : `${sqlInt(n)} FOLLOWING`);
    return ` ROWS BETWEEN ${at(f.start, 'UNBOUNDED PRECEDING')} AND ${at(f.end, 'UNBOUNDED FOLLOWING')}`;
  }

  expr(e: Expr): string {
    const d = this.d;
    const x = (v: Expr): string => this.expr(v);
    switch (e.k) {
      case 'col': return `t${e.t}.${e.q === null ? `c${e.c}` : `o${e.q}_${e.c}`}`;
      case 'out': return fail('construct', msg.sqlConstruct('a returned column inside an expression'));
      case 'param': return this.b.bind(e.ty, e.v);
      case 'null': return 'NULL';
      case 'agg': {
        if (e.x === null) return d.toDouble('count(*)');
        if (e.fn === 'count') return d.toDouble(e.distinct ? d.countDistinct(x(e.x)) : `count(${x(e.x)})`);
        const a = `${e.fn}(${x(e.x)})`;
        return e.fn === 'sum' || e.fn === 'avg' ? d.toDouble(a) : a;
      }
      case 'win': {
        if (d.id === 'clickhouse' && OFF_CLICKHOUSE.shifts.has(e.fn)) fail('dialect', msg.sqlConstructOn(`${e.fn}()`, 'ClickHouse'));
        const shift = e.fn === 'lag' || e.fn === 'lead';
        // ClickHouse (pin CH2, lifted): nothing there is the argument type's default (0) unless it is Nullable, so the
        // argument is made Nullable and a shift's default is NULL; `lagInFrame`/`leadInFrame` read the frame, so a shift
        // gets the whole partition; first_value/last_value skip NULLs unless told to respect them.
        const ch = d.id === 'clickhouse' && (shift || e.fn === 'first_value' || e.fn === 'last_value');
        const fn = !ch ? e.fn : shift ? `${e.fn}InFrame` : `${e.fn}_respect_nulls`;
        const args = e.fn === 'count' && e.x === null ? '*'
          : ch ? [`toNullable(${x(e.x as Expr)})`, ...(shift ? [sqlInt(e.offset ?? 1), 'NULL'] : [])].join(', ')
          : [e.x ? x(e.x) : '', e.offset === null ? '' : sqlInt(e.offset)].filter(Boolean).join(', ');
        const over: string[] = [];
        if (e.part.length) over.push(`PARTITION BY ${e.part.map(x).join(', ')}`);
        if (e.order.length) over.push(`ORDER BY ${e.order.map((o) => this.order(o)).join(', ')}`);
        const frame = e.frame ?? (ch && shift ? { start: null, end: null } : null); // a frame on a shift is refused (F1)
        const call = `${fn}(${args}) OVER (${over.join(' ')}${frame ? this.frame(frame) : ''})`;
        // Ranks and counts are integers on every engine, sums of DOUBLEs stay DOUBLE; F-D5 casts them all alike.
        return e.fn === 'min' || e.fn === 'max' || e.fn === 'lag' || e.fn === 'lead' || e.fn === 'first_value' || e.fn === 'last_value' ? call : d.toDouble(call);
      }
      case 'arith': return e.op === '/' ? `(${x(e.l)} / NULLIF(${x(e.r)}, 0))` : `(${x(e.l)} ${e.op} ${x(e.r)})`;
      case 'neg': return `(- ${x(e.x)})`;
      case 'days': return d.toDouble(`(${d.epochDay(x(e.l))} - ${d.epochDay(x(e.r))})`);
      case 'cmp': return `(${x(e.l)} ${e.op} ${x(e.r)})`;
      case 'and': return `(${e.xs.map(x).join(' AND ')})`;
      case 'or': return `(${e.xs.map(x).join(' OR ')})`;
      case 'not': return `(NOT ${x(e.x)})`;
      case 'isnull': return `(${x(e.x)} IS ${e.not ? 'NOT ' : ''}NULL)`;
      case 'between': return `(${x(e.x)} ${e.not ? 'NOT ' : ''}BETWEEN ${x(e.lo)} AND ${x(e.hi)})`;
      case 'in': return `(${x(e.x)} ${e.not ? 'NOT ' : ''}IN (${e.list.map(x).join(', ')}))`;
      case 'inq': return `(${x(e.x)} ${e.not ? 'NOT ' : ''}IN (${this.sub(e.q, e.corr)}))`;
      case 'exists': return `(${e.not ? 'NOT ' : ''}EXISTS (${this.sub(e.q, e.corr)}))`;
      case 'scalar': return `(${this.sub(e.q, e.corr)})`;
      case 'like': {
        // DuckDB's LIKE has no escape character; every other engine's has one, so the dialect's own is escaped.
        const pattern = this.b.bind('text', e.pattern.split(d.likeEscape).join(d.likeEscape + d.likeEscape));
        const like = `(${d.like(x(e.x), pattern)})`;
        return e.not ? `(NOT ${like})` : like;
      }
      case 'case': return `CASE ${e.when.map(([w, t]) => `WHEN ${x(w)} THEN ${x(t)}`).join(' ')}${e.else ? ` ELSE ${x(e.else)}` : ''} END`;
      case 'coalesce': return `COALESCE(${e.xs.map(x).join(', ')})`;
      case 'nullif': return `NULLIF(${x(e.a)}, ${x(e.b)})`;
      case 'cast':
        if (e.to === 'number') return d.number(x(e.x), true);
        if (e.to === 'date') return d.date(x(e.x), true, '');
        return d.isoDay(x(e.x));
      case 'trunc': return d.trunc(x(e.x), e.unit);
      case 'part': return d.toDouble(d.datePart(x(e.x), e.part));
      case 'abs': return `abs(${x(e.x)})`;
      case 'floor': return d.floor(x(e.x));
      case 'ceil': return d.ceil(x(e.x));
    }
  }
}

/** Already a DOUBLE as printed (F-D5): an aggregate count/sum/avg, a window rank or count, days between, a date part. */
function isDouble(e: Expr): boolean {
  if (e.k === 'agg') return e.fn === 'count' || e.fn === 'sum' || e.fn === 'avg';
  if (e.k === 'win') return !['min', 'max', 'lag', 'lead', 'first_value', 'last_value'].includes(e.fn);
  return e.k === 'days' || e.k === 'part';
}

/** Does the expression bind a value (outside its subqueries' own text, which never repeats)? */
const hasParam = (e: Expr): boolean => JSON.stringify(e).includes('"k":"param"');

/** The output kinds of a query, position by position. */
const kindsOf = (q: Query): Ty[] => q.items.map((it) => it.ty);

/**
 * The statement for `dialect`: each dataset read through its view (`inputs[i]` for `ir.views[i]`),
 * then the hoisted relations, then the query. Its columns are `o_0…`, positional to `ir.names`.
 */
export function printLiveSql(ir: LiveSqlIR, inputs: readonly ViewInput[], dialect: CompileDialectId | SqlDialect): { ok: true; query: CompiledQuery } | SqlRefusal | LiveRefusal {
  try {
    const d = dialectFor(dialect);
    if (inputs.length !== ir.views.length) throw new Error('one view input per dataset read');
    const b = new ParamSink();
    const views = ir.views.map((u, i) => `v${i} AS (${viewBody({ d, b, columns: inputs[i].env.columns, ...(inputs[i].env.keys?.length ? { keys: inputs[i].env.keys } : {}) }, u, inputs[i])})`);
    const p = new Printer(d, b);
    const rels = ir.rels.map((q, i) => `q${i} AS (${p.query(q, `o${i}_`, null, false)})`);
    const main = p.query(ir.main, 'o_', kindsOf(ir.main), true);
    const columns = ir.main.items.map((_, i) => `o_${i}`);
    // ClickHouse fills an outer join's missing side with each type's default (0, '') unless told to use NULL, as every
    // other engine and the DuckDB reference do (the nightly's FULL JOIN USING case found it).
    const settings = d.id === 'clickhouse' ? '\nSETTINGS join_use_nulls = 1' : '';
    return { ok: true, query: b.finish(`WITH ${[...views, ...rels].join(',\n')}\n${main}${settings}`, d, columns) };
  } catch (e) {
    if (e instanceof Refused) return e.refusal as SqlRefusal | LiveRefusal;
    throw e;
  }
}
