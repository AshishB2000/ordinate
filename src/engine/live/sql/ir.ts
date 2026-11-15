// The closed relational IR of SQL on Live datasets (docs/live-data/01-live-sql.md, F1) — PURE types.
//
// ./tree.ts builds it from DuckDB's parse of the model's statement; ./print.ts writes it per dialect.
// It is CLOSED: every node below is a construct of "What the IR allows (F1)", every name in it is an
// index (a view, a relation, a FROM instance, a column position) and every value a typed parameter.
// No string the model wrote survives into it except literal VALUES (bound, never printed) and a LIKE
// pattern (bound too). There is no generic function node, so a function outside the allow-list has
// nothing to become.

import type { DatePart, SetKind, TruncUnit } from '../dialect';

export type { SetKind } from '../dialect';

/**
 * The kind of a value, as DuckDB would type it over the view (F-D5, F-D7): every number a DOUBLE, a
 * date a DATE, `ts` what DuckDB's `date_trunc` returns over a DATE (a TIMESTAMP at midnight; Live
 * prints a DATE, the differential compares its day), `bool` a condition (never a returned column).
 */
export type Ty = 'number' | 'text' | 'date' | 'ts' | 'bool';

export type ParamTy = 'number' | 'text' | 'date';
export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type WinFn = 'row_number' | 'rank' | 'dense_rank' | 'lag' | 'lead' | 'first_value' | 'last_value' | AggFn;
export type CmpOp = '=' | '<>' | '<' | '>' | '<=' | '>=';
export type JoinKind = 'inner' | 'left' | 'right' | 'full';

export interface Order {
  e: Expr;
  desc: boolean;
  nullsFirst: boolean;
}

/** A window frame in ROWS: a bound is unbounded (null) or n rows from the current one (0 = CURRENT ROW). */
export interface Frame {
  start: number | null;
  end: number | null;
}

export type Expr =
  /** A column of FROM instance `t`: a view's `c<c>` (`q` null), or relation `q<q>`'s output `c`. */
  | { k: 'col'; t: number; c: number; q: number | null }
  /** An output of the SELECT this expression sits in (ORDER BY / GROUP BY only). */
  | { k: 'out'; i: number }
  | { k: 'param'; ty: ParamTy; v: string | number }
  | { k: 'null' }
  /** `count(*)` is `count` with no `x`. */
  | { k: 'agg'; fn: AggFn; distinct: boolean; x: Expr | null }
  | { k: 'win'; fn: WinFn; x: Expr | null; offset: number | null; part: Expr[]; order: Order[]; frame: Frame | null }
  | { k: 'arith'; op: '+' | '-' | '*' | '/'; l: Expr; r: Expr }
  | { k: 'neg'; x: Expr }
  /** `d1 - d2` on dates: days between, a number. */
  | { k: 'days'; l: Expr; r: Expr }
  | { k: 'cmp'; op: CmpOp; l: Expr; r: Expr }
  | { k: 'and' | 'or'; xs: Expr[] }
  | { k: 'not'; x: Expr }
  | { k: 'isnull'; x: Expr; not: boolean }
  | { k: 'between'; x: Expr; lo: Expr; hi: Expr; not: boolean }
  | { k: 'in'; x: Expr; list: Expr[]; not: boolean }
  /** `corr`: the subquery reads a column of an enclosing query. */
  | { k: 'inq'; x: Expr; q: Query; not: boolean; corr: boolean }
  | { k: 'exists'; q: Query; not: boolean; corr: boolean }
  | { k: 'scalar'; q: Query; corr: boolean }
  /** `x LIKE pattern` with DuckDB's meaning of the pattern (no escape character); bound when printed. */
  | { k: 'like'; x: Expr; pattern: string; not: boolean }
  | { k: 'case'; when: [Expr, Expr][]; else: Expr | null }
  | { k: 'coalesce'; xs: Expr[] }
  | { k: 'nullif'; a: Expr; b: Expr }
  | { k: 'cast'; to: 'number' | 'text' | 'date'; from: Ty; x: Expr }
  | { k: 'trunc'; unit: TruncUnit; x: Expr }
  | { k: 'part'; part: DatePart; x: Expr }
  | { k: 'abs' | 'floor' | 'ceil'; x: Expr };

/** A FROM item: a view or a relation read under a generated alias `t<t>`, or a join of two items. */
export type From =
  | { k: 'view'; v: number; t: number }
  | { k: 'rel'; q: number; t: number }
  | { k: 'join'; kind: JoinKind; l: From; r: From; on: Expr };

export interface Item {
  e: Expr;
  ty: Ty;
}

export interface Select {
  k: 'select';
  distinct: boolean;
  items: Item[];
  from: From | null;
  where: Expr | null;
  group: Expr[];
  having: Expr | null;
  order: Order[];
  limit: number | null;
}

export interface SetOp {
  k: 'set';
  op: SetKind;
  l: Query;
  r: Query;
  /** The output kinds, position by position (both sides agree). */
  items: { ty: Ty }[];
  order: Order[];
  limit: number | null;
}

export type Query = Select | SetOp;

/** One dataset the statement reads, printed as the view CTE `v<i>`, with the columns read from it (`c<j>`). */
export interface ViewUse {
  /** The slug the statement named it by (folded). */
  slug: string;
  /** The record id the slug resolved to. */
  id: string;
  /** The record's column names read, in `c<j>` order. */
  columns: string[];
}

export interface LiveSqlIR {
  views: ViewUse[];
  /** CTEs and derived tables, hoisted in dependency order: printed `q<i>`. */
  rels: Query[];
  main: Query;
  /** A display name per output column of `main` (an alias, else the column's name). */
  names: string[];
}
