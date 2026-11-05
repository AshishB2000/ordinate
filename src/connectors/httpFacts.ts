// A table's facts out of the two HTTP engines' own catalogs (docs/semantic-layer/02-source-tables.md, D6, D7):
// ClickHouse's system.columns and system.tables, and Databricks SQL's Unity Catalog information_schema plus
// DESCRIBE DETAIL. MAIN PROCESS ONLY. Neither engine has a describeTable, so these readers also supply the
// columns and types.
//
// Each statement goes through the HTTP family's own BOUND request builder (clickhouseRunBound,
// databricksRunBound): values are parameters, never text, and the transport is the family's bounded,
// SSRF-checked one. They are called as plain functions, not as a connector's `live.runBound`, because a facts
// read is not a Live statement (no warehouse(), nothing in live_usage; test-liveUsage forbids `.runBound(`
// outside liveRun.ts).
//
// UNVERIFIED: every statement and every column of its answer is written from the vendors' documentation and
// answered in the self-checks by a fixture. There is no ClickHouse server and no Databricks workspace behind
// this file yet.

import { clickhouseRunBound, databricksRunBound, type JsonRequest } from './liveHttp';
import { budgetMs, timeoutError } from './httpShared';
import { attempt, figure, flag, nameParts, records, str } from './factsRead';
import { FACTS_ROWS, MAX_KEY_COLUMNS, type FactColumn, type FactsQuery, type FactsReply, type OpenFacts, type TableFacts } from './tableFacts';
import type { ConnectorContext, ConnectorError, ConnectorRows, LiveParam } from './types';

type Run = (ctx: ConnectorContext, sql: string, params: LiveParam[]) => Promise<ConnectorRows | ConnectorError>;

/**
 * A FactsQuery over one of the family's bound runners. The whole read is inside ONE budget (ctx.timeoutMs):
 * each statement gets what is left, and one that would start after it is spent is not sent, which costs its field
 * (an optional read) and never the columns (the first, required one). An error is already redacted by the runner.
 * `named`: the answer's first row is its column names, lower-cased, and a reader finds a field by name (Databricks).
 */
function factsQuery(ctx: ConnectorContext, run: Run, named = false): FactsQuery {
  const until = Date.now() + budgetMs(ctx);
  return async (sql, params) => {
    const left = until - Date.now();
    if (left <= 0) throw timeoutError(budgetMs(ctx));
    const r = await run({ ...ctx, timeoutMs: left }, sql, params.map((value, i) => ({ name: `p${i}`, type: typeof value === 'number' ? 'number' : 'text', value })));
    if (!r.ok) throw new Error(r.error);
    return named ? [r.columns.map((c) => c.name.toLowerCase()), ...r.rows] : r.rows;
  };
}

// ── ClickHouse ───────────────────────────────────────────────────────────────

export const chQuery = (ctx: ConnectorContext): FactsQuery => factsQuery(ctx, clickhouseRunBound);

// UNVERIFIED: the is_in_* flags are UInt8 (0/1). `primary_key`, `sorting_key` and `partition_key` are EXPRESSIONS,
// so the key columns come from these flags, never from parsing the expression.
const CH_COLUMNS = `SELECT name, type, comment, is_in_primary_key, is_in_sorting_key, is_in_partition_key
  FROM system.columns WHERE database = {p0:String} AND table = {p1:String} ORDER BY position LIMIT ${FACTS_ROWS}`;
// UNVERIFIED: total_rows and total_bytes are NULL where the engine keeps no count (a view, Distributed, Merge) and
// UInt64s arrive as strings; the time is asked for as a Unix timestamp so no server zone has to be guessed.
const CH_TABLE = `SELECT comment, partition_key, total_rows, total_bytes, toUnixTimestamp(metadata_modification_time)
  FROM system.tables WHERE database = {p0:String} AND name = {p1:String} LIMIT 1`;

/** ClickHouse spells nullability in the type: `Nullable(T)`, or `LowCardinality(Nullable(T))`; `Array(Nullable(T))` is not a nullable column. */
const NULLABLE = /^(LowCardinality\()?Nullable\(/;

async function chRead(q: FactsQuery, database: string, name: string): Promise<FactsReply> {
  const rows = await q(CH_COLUMNS, [database, name]); // required: a refusal propagates
  const flagged = (i: number): string[] => rows.filter((r) => flag(r[i]) === true).map((r) => str(r[0])).filter(Boolean);
  const [key, sort, part] = [flagged(3), flagged(4), flagged(5)];
  const columns: FactColumn[] = rows.map((r) => {
    const col: FactColumn = { name: str(r[0]), type: str(r[1]), nullable: NULLABLE.test(str(r[1])) };
    if (str(r[2])) col.comment = str(r[2]);
    if (key.includes(col.name)) col.key = true;
    return col;
  }).filter((c) => c.name);
  if (columns.length === 0) return { ok: false, error: `No such table: ${name}` };
  const facts: { ok: true } & TableFacts = { ok: true, columns };
  // The primary key is the sparse index's prefix, not a uniqueness constraint. shortcut: key and sort columns are in the
  // table's column order, not the key's own (that needs the expression text); upgrade if the tab must show the key's order.
  if (key.length) facts.primaryKey = { columns: key, enforced: false };
  if (sort.length) facts.sortKey = sort;
  if (part.length) facts.partition = { columns: part };

  const table = (await attempt(q, CH_TABLE, [database, name]))?.[0];
  if (table) {
    if (str(table[0])) facts.comment = str(table[0]);
    if (facts.partition && str(table[1])) facts.partition.method = str(table[1]); // the expression as written: toYYYYMM(order_date)
    const [rowCount, bytes, seconds] = [figure(table[2]), figure(table[3]), figure(table[4])];
    if (rowCount !== undefined) facts.rowEstimate = Math.round(rowCount);
    if (bytes !== undefined) facts.bytes = bytes;
    const modified = new Date((seconds ?? 0) * 1000); // 0 is "no time"; an absurd one is an invalid date
    if (seconds && !Number.isNaN(modified.getTime())) facts.lastModified = modified.toISOString();
  }
  return facts;
}

/** `db.table`, or `table` in `opts.database`. Parses the name first (one or two parts, none empty): a bad one never sends a request. */
export function clickhouseTableFacts(table: string, open: OpenFacts, opts: { database: string }): Promise<FactsReply> {
  const parts = nameParts(table, 2);
  if (!parts) return Promise.resolve({ ok: false, error: 'Invalid table name' });
  return open((q) => chRead(q, parts.length === 2 ? parts[0] : opts.database, parts[parts.length - 1]));
}

// ── Databricks SQL ───────────────────────────────────────────────────────────

/** `request` is the transport: the family's guarded one unless a self-check hands in its own (the host is https-only, so no local server can stand in). */
export const dbxQuery = (ctx: ConnectorContext, request?: JsonRequest): FactsQuery => factsQuery(ctx, (c, sql, params) => databricksRunBound(c, sql, params, request), true);

/** A name part that may go in text, inside backticks, without escaping. Everything else is a bound value. */
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const tick = (part: string): string => `\`${part}\``;

// UNVERIFIED: Unity Catalog's information_schema.columns has full_data_type (`decimal(12,2)`) and is_nullable ('YES'/'NO').
const dbxColumns = (is: string): string => `SELECT column_name, full_data_type, is_nullable, comment
  FROM ${is}.columns WHERE table_schema = :p0 AND table_name = :p1 ORDER BY ordinal_position LIMIT ${FACTS_ROWS}`;
const dbxTable = (is: string): string => `SELECT comment, last_altered
  FROM ${is}.tables WHERE table_schema = :p0 AND table_name = :p1 LIMIT 1`;
// UNVERIFIED: Unity Catalog keeps keys as informational constraints (not enforced) in these two views.
const dbxKey = (is: string): string => `SELECT k.column_name
  FROM ${is}.table_constraints t JOIN ${is}.key_column_usage k
    ON k.constraint_catalog = t.constraint_catalog AND k.constraint_schema = t.constraint_schema AND k.constraint_name = t.constraint_name
   AND k.table_schema = t.table_schema AND k.table_name = t.table_name
 WHERE t.constraint_type = 'PRIMARY KEY' AND t.table_schema = :p0 AND t.table_name = :p1
 ORDER BY k.ordinal_position LIMIT ${MAX_KEY_COLUMNS}`;

/** A DESCRIBE DETAIL list (partitionColumns): the Statement API sends a complex type as JSON text. Junk is no list. */
function listOf(v: unknown): string[] {
  try {
    const a: unknown = typeof v === 'string' ? JSON.parse(v) : null;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  } catch {
    return [];
  }
}
/** A timestamp as the API wrote it, if it is one. */
const when = (v: unknown): string | undefined => (Number.isNaN(Date.parse(str(v))) ? undefined : str(v));

async function dbxRead(q: FactsQuery, catalog: string, schema: string, name: string): Promise<FactsReply> {
  // A catalog that is not a plain identifier (a hyphen) never goes in text: the request already sets the session's catalog.
  const cat = IDENT.test(catalog) ? catalog : '';
  const is = cat ? `${tick(cat)}.information_schema` : 'information_schema';
  const bound = [schema, name];
  const rows = records(await q(dbxColumns(is), bound)); // required: a refusal propagates
  const columns: FactColumn[] = rows.map((r) => {
    const col: FactColumn = { name: str(r.column_name), type: str(r.full_data_type) };
    if (flag(r.is_nullable) !== undefined) col.nullable = flag(r.is_nullable) as boolean;
    if (str(r.comment)) col.comment = str(r.comment);
    return col;
  }).filter((c) => c.name);
  if (columns.length === 0) return { ok: false, error: `No such table: ${name}` };
  const facts: { ok: true } & TableFacts = { ok: true, columns };

  const table = records(await attempt(q, dbxTable(is), bound))[0];
  if (table) {
    if (str(table.comment)) facts.comment = str(table.comment);
    const altered = when(table.last_altered);
    if (altered) facts.lastModified = altered;
  }
  const key = records(await attempt(q, dbxKey(is), bound)).map((r) => str(r.column_name)).filter(Boolean);
  if (key.length) {
    facts.primaryKey = { columns: key, enforced: false }; // informational: Unity Catalog does not enforce it
    for (const c of columns) if (key.includes(c.name)) c.key = true;
  }

  // Delta only: a view or a non-Delta table fails here and costs only these fields. It takes no LIMIT and no value (the
  // path is whitelisted and quoted) and answers one row; the row cap still bounds it.
  const path = [cat, schema, name].filter(Boolean);
  const detail = path.every((p) => IDENT.test(p)) ? records(await attempt(q, `DESCRIBE DETAIL ${path.map(tick).join('.')}`, []))[0] : undefined;
  if (detail) {
    const [partition, cluster, bytes] = [listOf(detail.partitioncolumns), listOf(detail.clusteringcolumns), figure(detail.sizeinbytes)];
    if (partition.length) facts.partition = { columns: partition, method: 'IDENTITY' };
    if (cluster.length) facts.clusterBy = cluster;
    if (bytes !== undefined) facts.bytes = bytes;
    const modified = when(detail.lastmodified); // the data's last commit beats the metadata's last change
    if (modified) facts.lastModified = modified;
  }
  return facts;
}

/**
 * `catalog.schema.table`, `schema.table` in the connection's catalog, or `table` in its schema (else "default"). Every
 * part must be a plain identifier, or nothing is sent: the name reaches DESCRIBE DETAIL as text. Unity Catalog stores
 * names in lower case, so that is how they are looked up.
 */
export function databricksTableFacts(table: string, open: OpenFacts, opts: { catalog?: string; schema?: string }): Promise<FactsReply> {
  const parts = nameParts(table, 3);
  if (!parts || !parts.every((p) => IDENT.test(p))) return Promise.resolve({ ok: false, error: 'Invalid table name' });
  const [name, schema, catalog] = [parts.pop() as string, parts.pop() ?? (opts.schema?.trim() || 'default'), parts.pop() ?? (opts.catalog?.trim() || '')];
  return open((q) => dbxRead(q, catalog.toLowerCase(), schema.toLowerCase(), name.toLowerCase()));
}
