// SQL on Live datasets, F1: DuckDB's parse of the model's statement → the closed IR (./ir.ts).
// docs/live-data/01-live-sql.md, F-D1…F-D4, "What the IR allows (F1)". PURE but for `parseSql`.
//
// The model writes DuckDB SQL; DuckDB's own parser reads it (`json_serialize_sql`, parse only, in
// the caller's locked org worker — `parseSql`, the one call here that is not pure); this walks the
// tree against the allow-list (./shapes.ts) and builds the IR:
//
//   - statements, CTEs, set operations, SELECT and FROM here; expressions in ./treeExpr.ts;
//   - every table name a slug of `env.tables` (a dataset the caller may read), or a CTE in scope;
//     a schema- or catalog-qualified name refused, as `sqlGate.astRelationError` refuses one;
//   - every column resolved (./scope.ts) to a FROM instance's column, every literal a parameter;
//   - nothing the model wrote kept as text but literal values and a LIKE pattern, both bound.
//
// The result names each dataset read with the columns read from it (`ir.views`): the executor (F3)
// takes each one's lock and hidden columns, and ./view.ts writes its view CTE from the record.

import type { From, Item, LiveSqlIR, Order, Select, SetKind, SetOp } from './ir';
import { isNode } from './shapes';
import type { Col, CteScope, Inst, QueryOut, Scope, SqlEnv, SqlRefusal, Tx, Typed } from './scope';
import { MAX_DEPTH, Refused, coerce, construct, fail, lookup, ref, sameExpr, tyOf, unify } from './scope';
import { NO_AGG, checked, cond, expr, orders, value, whole } from './treeExpr';
import { foldKey } from '../../datasetView';
import * as msg from '../../liveSqlMessages';

export type { SqlEnv, SqlRefusal, SqlTable } from './scope';

type Node = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** DuckDB's parse of one text — parse only, no binder, nothing opened — in the caller's (org) worker. */
export async function parseSql(text: string): Promise<unknown> {
  const duck: typeof import('../../duckdb') = require('../../duckdb');
  const row = (await duck.queryAsync('SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS j', [text]))[0];
  try {
    return JSON.parse(String(row.j)) as unknown;
  } catch {
    return null; // unreadable (or too deep to parse): refused by `translate`, never guessed at
  }
}

/** The model's statement (DuckDB's parse of it) as the IR, or why it cannot run on a Live dataset. */
export function translate(tree: unknown, env: SqlEnv): { ok: true; ir: LiveSqlIR } | SqlRefusal {
  try {
    const node = statementOf(tree);
    const tx: Tx = { env, views: [], rels: [], nextT: 0, depth: 0, query: (n, ctes, outer, corr) => query(n, ctes, outer, corr, tx) };
    const main = query(node, new Map(), null, null, tx);
    if (tx.views.length === 0) fail('noTable', msg.sqlNoTable());
    return { ok: true, ir: { views: tx.views, rels: tx.rels, main: main.q, names: main.names } };
  } catch (e) {
    if (e instanceof Refused) return e.refusal as SqlRefusal;
    throw e;
  }
}

function statementOf(tree: unknown): unknown {
  if (!isNode(tree)) return fail('statement', msg.sqlOneSelect());
  if (tree.error !== false) {
    if (tree.error_type === 'parser') {
      const m = str(tree.error_message).split(/\n\s*LINE \d+:/)[0].replace(/\s+/g, ' ').trim();
      return fail('parse', msg.sqlParseError(m.slice(0, 300)));
    }
    return fail('statement', msg.sqlOneSelect()); // DDL, SET, COPY, CALL, PRAGMA, PIVOT…: nothing serializes
  }
  checked(tree, 'root');
  const sts = list(tree.statements);
  if (sts.length !== 1) return fail('statement', msg.sqlOneSelect());
  return checked(sts[0], 'statement').node;
}

// ── Queries ──────────────────────────────────────────────────────────────────

function query(v: unknown, outerCtes: CteScope, outer: Scope | null, corr: { hit: boolean } | null, tx: Tx): QueryOut {
  const n = checked(v);
  if (++tx.depth > MAX_DEPTH) fail('depth', msg.sqlTooDeep());
  try {
    const ctes = withCtes(n, outerCtes, tx);
    if (n.type === 'SELECT_NODE') return select(n, ctes, outer, corr, tx);
    if (n.type === 'SET_OPERATION_NODE') return setOp(n, ctes, outer, corr, tx);
    return construct(str(n.type));
  } finally {
    tx.depth -= 1;
  }
}

/** A WITH list, in order: body i sees the CTEs before it (never itself — no RECURSIVE) and no enclosing columns. */
function withCtes(n: Node, outer: CteScope, tx: Tx): CteScope {
  const map = isNode(n.cte_map) ? list(checked(n.cte_map, 'ctemap').map) : [];
  if (!map.length) return outer;
  const scope = new Map(outer);
  const own = new Set<string>();
  for (const entry of map) {
    const e = checked(entry, 'cteentry');
    const name = foldKey(str(e.key));
    if (own.has(name)) fail('duplicate', msg.sqlAmbiguous(str(e.key)));
    const cte = checked(e.value, 'cte');
    const body = query(checked(cte.query, 'statement').node, scope, null, null, tx);
    tx.rels.push(body.q);
    scope.set(name, { q: tx.rels.length - 1, cols: body.cols });
    own.add(name);
  }
  return scope;
}

interface Modifiers {
  distinct: boolean;
  order: unknown[];
  limit: number | null;
}

function modifiers(n: Node): Modifiers {
  const out: Modifiers = { distinct: false, order: [], limit: null };
  for (const m of list(n.modifiers)) {
    const mod = checked(m);
    if (mod.type === 'DISTINCT_MODIFIER') out.distinct = true;
    else if (mod.type === 'ORDER_MODIFIER') out.order = list(mod.orders);
    else if (mod.type === 'LIMIT_MODIFIER') out.limit = whole(mod.limit);
    else construct(str(mod.type));
  }
  return out;
}

function select(n: Node, ctes: CteScope, outer: Scope | null, corr: { hit: boolean } | null, tx: Tx): QueryOut {
  const mods = modifiers(n);
  const groups = list(n.group_expressions);
  const sets = list(n.group_sets);
  // One plain grouping set naming every GROUP BY item; anything else is ROLLUP, CUBE or GROUPING SETS.
  const plain = groups.length === 0 ? sets.length === 0 : sets.length === 1 && JSON.stringify(sets[0]) === JSON.stringify(groups.map((_, i) => i));
  if (!plain) construct('GROUPING SETS, ROLLUP or CUBE');
  const sc: Scope = { insts: [], merged: new Map(), parent: outer, corr, ctes };
  const from = fromItem(n.from_table, sc, tx);

  const items: Item[] = [];
  const names: string[] = [];
  for (const raw of list(n.select_list)) {
    const it = checked(raw);
    if (it.class === 'STAR') {
      for (const c of star(it, sc)) {
        items.push({ e: c.t.e, ty: c.t.ty === 'null' ? 'text' : c.t.ty });
        names.push(c.name);
      }
      continue;
    }
    const t = expr(it, sc, { agg: true, win: true }, tx, true);
    if (t.ty === 'bool') fail('type', msg.sqlTrueFalse());
    const settled = t.lit ? coerce(t, t.lit) : t;
    items.push({ e: settled.e, ty: settled.ty === 'null' ? 'text' : settled.ty });
    const cols = it.class === 'COLUMN_REF' ? list(it.column_names).map(str) : [];
    names.push(str(it.alias) || cols[cols.length - 1] || `col${items.length}`);
  }
  const folded = names.map(foldKey);
  const outIndex = (e: unknown): number => {
    const one = isNode(e) && e.class === 'COLUMN_REF' && list(e.column_names).length === 1 ? foldKey(str(list(e.column_names)[0])) : null;
    if (one === null) return -1;
    const hits = folded.flatMap((f, i) => (f === one ? [i] : []));
    if (hits.length > 1) fail('ambiguous', msg.sqlAmbiguous(one));
    return hits.length ? hits[0] : -1;
  };
  const asOut = (e: Typed['e']): Typed['e'] => {
    const i = items.findIndex((it) => sameExpr(it.e, e));
    return i >= 0 ? { k: 'out', i } : e;
  };
  const noPosition = (e: unknown, clause: string): void => {
    if (isNode(e) && (e.class === 'CONSTANT' || e.class === 'POSITIONAL_REFERENCE' || e.class === 'STAR')) construct(`${clause} ${e.class === 'STAR' ? 'ALL' : '1'}`);
  };

  const where = n.where_clause == null ? null : cond(n.where_clause, sc, NO_AGG, tx);
  const group = groups.map((g) => {
    noPosition(g, 'GROUP BY');
    // DuckDB reads a GROUP BY name as a column first, then as a returned column's alias.
    try {
      return asOut(value(g, sc, NO_AGG, tx).e);
    } catch (e) {
      const i = outIndex(g);
      if (i >= 0 && e instanceof Refused && e.refusal.code === 'column') return { k: 'out' as const, i };
      throw e;
    }
  });
  const having = n.having == null ? null : cond(n.having, sc, { agg: true, win: false }, tx);
  // DuckDB reads an ORDER BY name as a returned column's alias first.
  const order: Order[] = orders(mods.order, (e) => {
    noPosition(e, 'ORDER BY');
    const i = outIndex(e);
    return i >= 0 ? { k: 'out', i } : asOut(value(e, sc, { agg: true, win: true }, tx).e);
  });
  const q: Select = { k: 'select', distinct: mods.distinct, items, from, where, group, having, order, limit: mods.limit };
  return { q, cols: items.map((it, i) => ({ name: names[i], ty: it.ty })), names };
}

/** `*` or `t.*`: every visible column of every FROM instance (or of `t`), in FROM order. */
function star(it: Node, sc: Scope): { name: string; t: Typed }[] {
  if (sc.merged.size) construct('SELECT * with USING');
  const rel = foldKey(str(it.relation_name));
  const insts = rel === '' ? sc.insts : sc.insts.filter((i) => i.name === rel);
  if (rel !== '' && insts.length === 0) fail('table', msg.sqlUnknownTable(str(it.relation_name)));
  if (insts.length === 0) construct('SELECT * with no table');
  return insts.flatMap((inst) => inst.cols.map((c, i) => ({ name: c.name, t: ref(inst, i) })));
}

const SET_KINDS: Record<string, SetKind> = { UNION: 'union', EXCEPT: 'except', INTERSECT: 'intersect' };

function setOp(n: Node, ctes: CteScope, outer: Scope | null, corr: { hit: boolean } | null, tx: Tx): QueryOut {
  const kind = SET_KINDS[str(n.setop_type)];
  if (!kind) return construct(str(n.setop_type).replace(/_/g, ' '));
  const all = n.setop_all === true;
  if (all && kind !== 'union') construct(`${str(n.setop_type)} ALL`);
  const side = (v: unknown): QueryOut => {
    const s = query(v, ctes, outer, corr, tx);
    if (s.q.order.length || s.q.limit !== null) construct('ORDER BY or LIMIT inside a set operation');
    return s;
  };
  const l = side(n.left);
  const r = side(n.right);
  if (l.cols.length !== r.cols.length) fail('columns', msg.sqlColumns());
  const cols: Col[] = l.cols.map((c, i) => {
    try {
      return { name: c.name, ty: unify([{ e: { k: 'null' }, ty: c.ty }, { e: { k: 'null' }, ty: r.cols[i].ty }]) };
    } catch (e) {
      if (e instanceof Refused) fail('columns', msg.sqlColumns());
      throw e;
    }
  });
  const mods = modifiers(n);
  if (mods.distinct) construct('DISTINCT on a set operation');
  const folded = cols.map((c) => foldKey(c.name));
  const order = orders(mods.order, (e) => {
    const parts = isNode(e) && e.class === 'COLUMN_REF' ? list(e.column_names).map(str) : [];
    const i = parts.length === 1 ? folded.indexOf(foldKey(parts[0])) : -1;
    if (i < 0) return construct('ORDER BY anything but a returned column after a set operation');
    if (folded.indexOf(foldKey(parts[0]), i + 1) >= 0) fail('ambiguous', msg.sqlAmbiguous(parts[0]));
    return { k: 'out', i };
  });
  const q: SetOp = { k: 'set', op: all ? 'unionAll' : kind, l: l.q, r: r.q, items: cols.map((c) => ({ ty: c.ty === 'null' ? 'text' : c.ty })), order, limit: mods.limit };
  return { q, cols, names: l.names };
}

// ── FROM ─────────────────────────────────────────────────────────────────────

interface Placed {
  from: From;
  insts: Inst[];
}

function fromItem(v: unknown, sc: Scope, tx: Tx): From | null {
  const n = checked(v);
  if (n.type === 'EMPTY') return null;
  return place(n, sc, tx).from;
}

function addInst(sc: Scope, inst: Inst): void {
  if (inst.name !== '' && sc.insts.some((i) => i.name === inst.name)) fail('duplicate', msg.sqlAmbiguous(inst.name));
  sc.insts.push(inst);
}

function place(v: unknown, sc: Scope, tx: Tx): Placed {
  const n = checked(v);
  const alias = foldKey(str(n.alias));
  switch (n.type) {
    case 'BASE_TABLE': {
      const table = str(n.table_name);
      if (str(n.schema_name) || str(n.catalog_name)) fail('qualified', msg.sqlQualified([n.catalog_name, n.schema_name, table].map(str).filter(Boolean).join('.').slice(0, 120)));
      const key = foldKey(table);
      const t = tx.nextT++;
      const cte = sc.ctes.get(key);
      let inst: Inst;
      if (cte) inst = { t, name: alias || key, cols: cte.cols, q: cte.q };
      else {
        const rec = tx.env.tables.get(key);
        if (!rec) return fail('table', msg.sqlUnknownTable(table.slice(0, 120)));
        let v = tx.views.findIndex((u) => u.id === rec.id);
        if (v < 0) v = tx.views.push({ slug: key, id: rec.id, columns: [] }) - 1;
        // A view projects only the columns the statement reads (a calc it does not read is never computed).
        const read = tx.views[v].columns;
        const reg = (c: number): number => {
          const at = read.indexOf(rec.columns[c].name);
          return at >= 0 ? at : read.push(rec.columns[c].name) - 1;
        };
        inst = { t, name: alias || key, cols: rec.columns.map((c) => ({ name: c.name, ty: tyOf(c.type) })), q: null, reg };
        addInst(sc, inst);
        return { from: { k: 'view', v, t }, insts: [inst] };
      }
      addInst(sc, inst);
      return { from: { k: 'rel', q: inst.q as number, t }, insts: [inst] };
    }
    case 'SUBQUERY': {
      const body = query(checked(n.subquery, 'statement').node, sc.ctes, null, null, tx);
      tx.rels.push(body.q);
      const inst: Inst = { t: tx.nextT++, name: alias, cols: body.cols, q: tx.rels.length - 1 };
      addInst(sc, inst);
      return { from: { k: 'rel', q: inst.q as number, t: inst.t }, insts: [inst] };
    }
    case 'JOIN':
      return join(n, sc, tx);
    default:
      return construct(str(n.type));
  }
}

const JOIN_KINDS: Record<string, 'inner' | 'left' | 'right' | 'full'> = { INNER: 'inner', LEFT: 'left', RIGHT: 'right', FULL: 'full' };

function join(n: Node, sc: Scope, tx: Tx): Placed {
  if (n.ref_type !== 'REGULAR') construct(`${str(n.ref_type)} JOIN`);
  const kind = JOIN_KINDS[str(n.join_type)];
  if (!kind) construct(`${str(n.join_type)} JOIN`);
  const l = place(n.left, sc, tx);
  const r = place(n.right, sc, tx);
  const using = list(n.using_columns).map(str);
  if ((n.condition == null) === (using.length === 0)) construct('a join with neither ON nor USING');
  if (n.condition != null) return { from: { k: 'join', kind, l: l.from, r: r.from, on: cond(n.condition, sc, NO_AGG, tx) }, insts: [...l.insts, ...r.insts] };
  // USING (k) is written out as ON l.k = r.k; an unqualified k is then the merged column, as DuckDB reads it.
  const on: Typed['e'][] = [];
  for (const name of using) {
    const side = (insts: Inst[]): Typed => lookup({ insts, merged: new Map(), parent: null, corr: null, ctes: sc.ctes }, [name], tx);
    const a = side(l.insts);
    const b = side(r.insts);
    const ty = unify([a, b]);
    on.push({ k: 'cmp', op: '=', l: coerce(a, ty).e, r: coerce(b, ty).e });
    const key = foldKey(name);
    if (sc.merged.has(key)) fail('ambiguous', msg.sqlAmbiguous(name));
    sc.merged.set(key, kind === 'full' ? { e: { k: 'coalesce', xs: [a.e, b.e] }, ty } : kind === 'right' ? b : a);
  }
  return { from: { k: 'join', kind, l: l.from, r: r.from, on: on.length === 1 ? on[0] : { k: 'and', xs: on } }, insts: [...l.insts, ...r.insts] };
}
