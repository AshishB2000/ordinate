// Names, kinds and refusals for the SQL translator (docs/live-data/01-live-sql.md F-D3, F-D4) — PURE.
//
// Shared by ./tree.ts (statements, FROM) and ./treeExpr.ts (expressions): the typed refusal, the
// translation state, the scopes a column name resolves in, and the two rules that type a literal
// from its context (`unify`, `coerce`).
//
// Name resolution (F-D3): a column resolves against the FROM instances of its own SELECT — a view's
// VISIBLE columns, or a CTE's or derived table's outputs — case-insensitively as DuckDB folds
// (ASCII only, `foldKey`); two candidates are ambiguous, refused. Only an expression subquery sees
// the query around it (its scope's `parent`), and such a reference marks it correlated. A FROM
// subquery or a CTE body sees no enclosing columns at all (DuckDB would read one as LATERAL).

import { foldKey } from '../../datasetView';
import type { ColumnType } from '../../../data/parse';
import { daysFromIso } from '../../../analysis/dateIntel';
import type { Expr, Query, Ty, ViewUse } from './ir';
import * as msg from '../../liveSqlMessages';

export type SqlCode =
  | 'parse' | 'statement' | 'construct' | 'function' | 'table' | 'qualified' | 'column' | 'ambiguous'
  | 'duplicate' | 'type' | 'date' | 'number' | 'whole' | 'aggregate' | 'window' | 'columns' | 'like'
  | 'unit' | 'noTable' | 'depth' | 'dialect';

/** Why a statement cannot run on a Live dataset, in a catalog sentence. Never a partial answer. */
export interface SqlRefusal {
  ok: false;
  code: SqlCode;
  message: string;
}

/** Thrown inside the translator and the printer; their entry points return it as a value. */
export class Refused extends Error {
  constructor(readonly refusal: { ok: false; code: string; message: string }) {
    super(refusal.message);
  }
}

export function fail(code: SqlCode, message: string): never {
  throw new Refused({ ok: false, code, message });
}

export const construct = (what: string): never => fail('construct', msg.sqlConstruct(what));
export const mixed = (): never => fail('type', msg.sqlMixed());

/** One dataset the statement may name: its record id and the caller's VISIBLE columns (hidden ones are absent). */
export interface SqlTable {
  id: string;
  columns: readonly { name: string; type: ColumnType }[];
}

export interface SqlEnv {
  /** Folded slug → dataset. Nothing else is a table name. */
  tables: ReadonlyMap<string, SqlTable>;
  /** Today's UTC day, `YYYY-MM-DD`: what `current_date` binds (F-D4). */
  today: string;
}

export interface Col {
  name: string;
  ty: Ty | 'null';
}

/** One FROM item under its generated alias `t<t>`: a view (`q` null) or relation `q<q>`. */
export interface Inst {
  t: number;
  /** The name a qualified reference uses (alias, else the table's), folded; '' for an unnamed subquery. */
  name: string;
  cols: readonly Col[];
  q: number | null;
  /** A view's: the position column `c` takes among the columns its view CTE projects (registered on first read). */
  reg?: (c: number) => number;
}

export type CteScope = ReadonlyMap<string, { q: number; cols: readonly Col[] }>;

export interface Scope {
  insts: Inst[];
  /** USING columns, folded name → the merged reference. */
  merged: Map<string, Typed>;
  parent: Scope | null;
  /** Set on an expression subquery's scope: marked when a name resolves outside it. */
  corr: { hit: boolean } | null;
  ctes: CteScope;
}

/** A translated expression and its kind; `lit` while a literal's kind may still follow its context. */
export interface Typed {
  e: Expr;
  ty: Ty | 'null';
  lit?: 'text' | 'number';
}

export interface QueryOut {
  q: Query;
  cols: Col[];
  names: string[];
}

/** The state of one translation. */
export interface Tx {
  env: SqlEnv;
  views: ViewUse[];
  rels: Query[];
  nextT: number;
  depth: number;
  query(node: unknown, ctes: CteScope, outer: Scope | null, corr: { hit: boolean } | null): QueryOut;
}

export const MAX_DEPTH = 120;

export const tyOf = (t: ColumnType): Ty => (t === 'number' ? 'number' : t === 'date' ? 'date' : 'text');
const dateish = (t: string): boolean => t === 'date' || t === 'ts';

/** The one kind a list of values shares — DuckDB's own promotion: a DATE meets a TIMESTAMP as a TIMESTAMP. */
export function unify(ts: readonly Typed[]): Ty {
  let ty: Ty | null = null;
  for (const t of ts) {
    if (t.lit || t.ty === 'null') continue;
    if (t.ty === 'bool') fail('type', msg.sqlTrueFalse());
    if (ty === null) ty = t.ty;
    else if (ty !== t.ty) ty = dateish(ty) && dateish(t.ty) ? 'ts' : mixed();
  }
  if (ty === null) {
    for (const t of ts) {
      if (!t.lit) continue;
      if (ty === null) ty = t.lit;
      else if (ty !== t.lit) mixed();
    }
  }
  return ty ?? 'text';
}

/** `t` as a value of kind `ty`: a text literal met by a date becomes a bound DATE; any other mismatch is refused. */
export function coerce(t: Typed, ty: Ty): Typed {
  if (t.ty === 'null') return { e: t.e, ty };
  if (t.lit) {
    if (t.lit === ty) return { e: t.e, ty };
    if (dateish(ty) && t.lit === 'text' && t.e.k === 'param') return { e: { k: 'param', ty: 'date', v: isoDay(String(t.e.v)) }, ty: 'date' };
    return mixed();
  }
  if (t.ty === ty || (dateish(t.ty) && dateish(ty))) return { e: t.e, ty: t.ty };
  return mixed();
}

/** A `YYYY-MM-DD` that is a real day, or refused. */
export function isoDay(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || daysFromIso(v) === null) fail('date', msg.sqlBadDate(v.slice(0, 40)));
  return v;
}

/** The columns of an instance matching a folded name. */
const colsNamed = (inst: Inst, name: string): number[] =>
  inst.cols.flatMap((c, i) => (foldKey(c.name) === name ? [i] : []));

export function ref(inst: Inst, c: number): Typed {
  return { e: { k: 'col', t: inst.t, c: inst.reg ? inst.reg(c) : c, q: inst.q }, ty: inst.cols[c].ty };
}

/** A column reference (`column_names`, 1 or 2 parts) in `sc`, or refused. `current_date` binds today when no column has the name. */
export function lookup(sc: Scope, parts: readonly string[], tx: Tx): Typed {
  if (parts.length > 2 || parts.length === 0) fail('qualified', msg.sqlQualified(parts.join('.').slice(0, 120)));
  const name = foldKey(parts[parts.length - 1]);
  for (let s: Scope | null = sc; s; s = s.parent) {
    if (parts.length === 2) {
      const rel = foldKey(parts[0]);
      const inst = s.insts.find((i) => i.name !== '' && i.name === rel);
      if (inst) {
        const hits = colsNamed(inst, name);
        if (hits.length > 1) fail('ambiguous', msg.sqlAmbiguous(parts.join('.')));
        if (hits.length === 0) fail('column', msg.sqlUnknownColumn(parts.join('.')));
        return ref(inst, hits[0]);
      }
    } else {
      const merged = s.merged.get(name);
      if (merged) return merged;
      const hits = s.insts.flatMap((inst) => colsNamed(inst, name).map((c) => ref(inst, c)));
      if (hits.length > 1) fail('ambiguous', msg.sqlAmbiguous(parts[0]));
      if (hits.length === 1) return hits[0];
    }
    if (s.corr && s.parent) s.corr.hit = true;
  }
  if (parts.length === 1 && name === 'current_date') return { e: { k: 'param', ty: 'date', v: isoDay(tx.env.today) }, ty: 'date' };
  return fail('column', msg.sqlUnknownColumn(parts.join('.').slice(0, 120)));
}

/** Two expressions written the same way, so a GROUP BY or ORDER BY item can name its output instead. */
export const sameExpr = (a: Expr, b: Expr): boolean => JSON.stringify(a) === JSON.stringify(b);
