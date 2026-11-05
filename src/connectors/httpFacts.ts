// A table's facts out of the two HTTP engines' own catalogs (docs/semantic-layer/02-source-tables.md, D6, D7):
// ClickHouse's system.columns and system.tables. MAIN PROCESS ONLY. ClickHouse has no describeTable, so this
// reader also supplies the columns and types.
//
// Each statement goes through the HTTP family's own BOUND request builder (clickhouseRunBound): values are
// query parameters, never text, and the transport is the family's bounded, SSRF-checked one. It is called as a
// plain function, not as a connector's `live.runBound`, because a facts read is not a Live statement (no
// warehouse(), nothing in live_usage; test-liveUsage forbids `.runBound(` outside liveRun.ts).
//
// UNVERIFIED: every statement and every column of its answer is written from the ClickHouse documentation and
// answered in the self-checks by a fixture; no server has answered them.

import { clickhouseRunBound } from './liveHttp';
import { budgetMs, timeoutError } from './httpShared';
import { attempt, figure, flag, nameParts, str } from './factsRead';
import { FACTS_ROWS, type FactColumn, type FactsQuery, type FactsReply, type OpenFacts, type TableFacts } from './tableFacts';
import type { ConnectorContext, ConnectorError, ConnectorRows, LiveParam } from './types';

type Run = (ctx: ConnectorContext, sql: string, params: LiveParam[]) => Promise<ConnectorRows | ConnectorError>;

/**
 * A FactsQuery over one of the family's bound runners. The whole read is inside ONE budget (ctx.timeoutMs):
 * each statement gets what is left, and one that would start after it is spent is not sent, which costs its field
 * (an optional read) and never the columns (the first, required one). An error is already redacted by the runner.
 */
function factsQuery(ctx: ConnectorContext, run: Run): FactsQuery {
  const until = Date.now() + budgetMs(ctx);
  return async (sql, params) => {
    const left = until - Date.now();
    if (left <= 0) throw timeoutError(budgetMs(ctx));
    const r = await run({ ...ctx, timeoutMs: left }, sql, params.map((value, i) => ({ name: `p${i}`, type: typeof value === 'number' ? 'number' : 'text', value })));
    if (!r.ok) throw new Error(r.error);
    return r.rows;
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
