// A table's facts out of the PostgreSQL family's catalog (docs/semantic-layer/02-source-tables.md, D6, D7):
// comments, columns with types, the primary key, indexes, the partition key, size and the planner's
// estimate; on Redshift the distribution and sort key too. MAIN PROCESS ONLY, but it imports no driver:
// postgres.ts hands it `open`, which connects (guarded, SSRF-pinned) and closes, and a query function.
//
// UNVERIFIED: every statement is written from the PostgreSQL and Redshift documentation and answered in
// the self-checks by a recording fake; test-pgFacts-db.ts runs them on a real PostgreSQL, nothing has run
// on Redshift, CockroachDB, YugabyteDB, Materialize, QuestDB or RisingWave. So the ladder keeps whatever
// answers: the relation and the columns are read first, each of the rest costs its field when it fails,
// and with no readable pg_class or pg_attribute the columns come from information_schema (today's
// describeTable statement) with no comments.
//
// The schema and name are BOUND (`$1`/`$2`), the relation's oid is bound as `$1::oid`, and every
// statement ends in `limit N`. Redshift is not Postgres: no pg_get_partkeydef, no pg_index, no
// pg_total_relation_size, informational keys (`enforced: false`), and SVV_TABLE_INFO leaves out empty tables.

import { splitTop } from './factsRead';
import { FACTS_ROWS, type FactColumn, type FactsQuery, type FactsReply, type OpenFacts, type TableFacts } from './tableFacts';

const N = FACTS_ROWS;
const NOT_SYSTEM = `n.nspname not in ('pg_catalog', 'information_schema')`;

const RELATION_SQL = `select c.oid, n.nspname, obj_description(c.oid, 'pg_class'), c.reltuples
                        from pg_class c join pg_namespace n on n.oid = c.relnamespace
                       where c.relname = $2 and ($1::text is null or n.nspname = $1::text) and ${NOT_SYSTEM}
                       order by n.nspname limit 1`;
const ATTRIBUTES_SQL = `select a.attname, format_type(a.atttypid, a.atttypmod), not a.attnotnull, col_description(a.attrelid, a.attnum)
                          from pg_attribute a
                         where a.attrelid = $1::oid and a.attnum > 0 and not a.attisdropped
                         order by a.attnum limit ${N}`;
// A key lists its columns by number, in the key's own order: the text of the list ('{2,1}' / '2 1') is read back in JS,
// because unnest ... with ordinality is not on every engine here (Redshift has neither).
// UNVERIFIED on the pgwire engines (CockroachDB, YugabyteDB, Materialize, QuestDB, RisingWave): none was asked, like their `listTables`.
const KEY_SQL = `select a.attname, a.attnum, k.conkey::text
                   from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
                  where k.conrelid = $1::oid and k.contype = 'p' limit ${N}`;
const INDEXES_SQL = `select i.relname, ix.indisunique, am.amname, a.attname, a.attnum, ix.indkey::text
                       from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_am am on am.oid = i.relam
                       join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)
                      where ix.indrelid = $1::oid order by i.relname limit ${N}`;
const PARTITION_SQL = `select pg_get_partkeydef($1::oid) limit 1`;
// A partitioned table holds no data itself (its own size is 0): PostgreSQL 12+ sums the tree, and a plain table is its own tree.
const TREE_SIZE_SQL = `select coalesce((select sum(pg_total_relation_size(relid)) from pg_partition_tree($1::oid)), pg_total_relation_size($1::oid)) limit 1`;
const SIZE_SQL = `select pg_total_relation_size($1::oid) limit 1`;
// UNVERIFIED: SVV_TABLE_INFO's names and units (diststyle, sortkey1, size in 1 MB blocks, tbl_rows) are from the Redshift documentation.
const REDSHIFT_SQL = `select diststyle, sortkey1, "size", tbl_rows from svv_table_info where "schema" = $1 and "table" = $2 limit 1`;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const figure = (v: unknown): number | undefined => (v === null || v === '' ? undefined : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
const flag = (v: unknown): boolean | undefined => (v === true || v === 't' || v === 'true' || v === 'YES' ? true : v === false || v === 'f' || v === 'false' || v === 'NO' ? false : undefined);

/** A statement whose failure costs its field, never the read. */
async function attempt(q: FactsQuery, sql: string, params: (string | number | null)[]): Promise<unknown[][] | undefined> {
  try {
    return await q(sql, params);
  } catch {
    return undefined;
  }
}

/** The names of rows `[name, attnum, …, list]`, in the order the list gives the numbers. */
function inListOrder(rows: unknown[][], listAt: number): string[] {
  const order = (str(rows[0]?.[listAt]).match(/\d+/g) ?? []).map(Number);
  return [...rows].sort((a, b) => order.indexOf(Number(a[1])) - order.indexOf(Number(b[1]))).map((r) => str(r[0]));
}

/** `RANGE (order_date)` (pg_get_partkeydef) → the method and the columns; an expression is kept as written. */
export function parsePartitionKey(def: string): TableFacts['partition'] {
  const m = /^(\w+)\s*\(([\s\S]*)\)\s*$/.exec(def.trim());
  const columns = m ? splitTop(m[2]).map((c) => (/^"([^"]|"")*"$/.test(c) ? c.slice(1, -1).replace(/""/g, '"') : c)) : [];
  return m && columns.length ? { columns, method: m[1].toUpperCase() } : undefined;
}

/** Redshift's `diststyle`: EVEN, ALL, KEY(col), and the AUTO(...) forms. */
export function parseDistribution(raw: string): TableFacts['distribution'] {
  const m = /^(AUTO\s*\()?\s*(EVEN|ALL|KEY)\s*(?:\(\s*"?([^")]+?)"?\s*\))?\s*\)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const style = m[2].toUpperCase();
  return { style: m[1] ? `AUTO(${style})` : style, columns: m[3] ? [m[3]] : [] };
}

/** The columns information_schema reports (a pgwire engine's fallback): no comments, no key. */
async function schemaColumns(q: FactsQuery, sql: string, schema: string | null, name: string): Promise<FactColumn[]> {
  const rows = await q(`${sql} limit ${N}`, [schema, name]);
  return rows.map((r) => ({ name: str(r[0]), type: str(r[1]), ...(flag(r[2]) === undefined ? {} : { nullable: flag(r[2]) as boolean }) })).filter((c) => c.name);
}

async function readFacts(q: FactsQuery, schema: string | null, name: string, opts: { redshift: boolean; columnsSql: string; timeoutMs?: number }): Promise<FactsReply> {
  const until = Date.now() + (opts.timeoutMs ?? 30_000);
  const optional = (): boolean => Date.now() < until; // each statement has its own timeout; the read as a whole has this one
  const rel = (await attempt(q, RELATION_SQL, [schema, name]))?.[0];
  const oid = rel && /^\d+$/.test(str(rel[0])) ? Number(rel[0]) : null;
  const facts: { ok: true } & TableFacts = { ok: true, columns: [] };
  if (rel && oid !== null) {
    if (str(rel[2])) facts.comment = str(rel[2]);
    const estimate = figure(rel[3]);
    if (estimate !== undefined) facts.rowEstimate = Math.round(estimate);
    const attrs = await attempt(q, ATTRIBUTES_SQL, [oid]);
    facts.columns = (attrs ?? []).map((r) => {
      const col: FactColumn = { name: str(r[0]), type: str(r[1]) };
      if (flag(r[2]) !== undefined) col.nullable = flag(r[2]) as boolean;
      if (str(r[3])) col.comment = str(r[3]);
      return col;
    }).filter((c) => c.name);
  }
  if (facts.columns.length === 0) facts.columns = await schemaColumns(q, opts.columnsSql, schema, name);
  if (facts.columns.length === 0) return { ok: false, error: `No such table: ${name}` };
  if (!rel || oid === null) return facts; // no readable pg_class: the columns are all there is

  if (optional()) {
    const keyRows = await attempt(q, KEY_SQL, [oid]);
    if (keyRows?.length) {
      const columns = inListOrder(keyRows, 2);
      facts.primaryKey = { columns, enforced: !opts.redshift };
      for (const c of facts.columns) if (columns.includes(c.name)) c.key = true;
    }
  }
  if (!opts.redshift && optional()) {
    const rows = await attempt(q, INDEXES_SQL, [oid]);
    const byName = new Map<string, unknown[][]>();
    for (const r of rows ?? []) byName.set(str(r[0]), [...(byName.get(str(r[0])) ?? []), r]);
    const indexes = [...byName].map(([n, rs]) => ({ name: n, columns: inListOrder(rs.map((r) => [r[3], r[4], r[5]]), 2), unique: flag(rs[0][1]) === true, kind: str(rs[0][2]) }));
    if (indexes.length) facts.indexes = indexes;
  }
  if (!opts.redshift && optional()) {
    const partition = parsePartitionKey(str((await attempt(q, PARTITION_SQL, [oid]))?.[0]?.[0]));
    if (partition) facts.partition = partition;
  }
  if (!opts.redshift && optional()) {
    const bytes = figure(((await attempt(q, TREE_SIZE_SQL, [oid])) ?? (await attempt(q, SIZE_SQL, [oid])))?.[0]?.[0]);
    if (bytes !== undefined) facts.bytes = bytes;
  }
  if (opts.redshift && optional()) {
    // SVV_TABLE_INFO leaves out an empty table: no row is not an error, it is a table with no distribution to report.
    const info = (await attempt(q, REDSHIFT_SQL, [str(rel[1]) || schema, name]))?.[0];
    if (info) {
      const distribution = parseDistribution(str(info[0]));
      if (distribution) facts.distribution = distribution;
      if (str(info[1])) facts.sortKey = [str(info[1])];
      const blocks = figure(info[2]);
      if (blocks !== undefined) facts.bytes = blocks * 1_048_576; // `size` counts 1 MB blocks
      const rows = figure(info[3]);
      if (rows !== undefined) facts.rowEstimate = Math.round(rows);
    }
  }
  return facts;
}

/** Parses `table` first (at most two parts, none empty): a bad name never opens a socket. */
export function pgTableFacts(table: string, open: OpenFacts, opts: { redshift: boolean; columnsSql: string; timeoutMs?: number }): Promise<FactsReply> {
  const parts = String(table ?? '').trim().split('.');
  if (parts.length > 2 || parts.some((p) => !p)) return Promise.resolve({ ok: false, error: 'Invalid table name' });
  return open((q) => readFacts(q, parts.length === 2 ? parts[0] : null, parts[parts.length - 1], opts));
}
