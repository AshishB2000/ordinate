// A table's facts out of the MySQL family's information_schema (docs/semantic-layer/02-source-tables.md,
// D6, D7): comments, columns with types, the primary key and indexes, the partition key, size and the
// server's estimate. MAIN PROCESS ONLY, but it imports no driver: mysql.ts hands it `open`, which
// connects (guarded, SSRF-pinned, bounded) and closes, and a query function.
//
// UNVERIFIED: every statement is written from the MySQL and MariaDB documentation and answered in the
// self-checks by a fixture; nothing has run on MySQL, MariaDB, Aurora, TiDB, SingleStore, StarRocks, Doris
// or PlanetScale. A hosted plan may hide information_schema (PlanetScale is the known case), so only the
// COLUMNS read is required and each of the rest costs its field.
//
// The name and the schema are BOUND (`?`), never text, and every statement ends in `LIMIT n`.

import { attempt, figure, flag, nameParts, str, foldIndexes, type FactParam } from './factsRead';
import { FACTS_ROWS, type FactColumn, type FactsQuery, type FactsReply, type OpenFacts, type TableFacts } from './tableFacts';

// UNVERIFIED: COLUMN_KEY = 'PRI' marks a primary-key column; the schema comes back so an unqualified name settles on one schema.
const COLUMNS_SQL = `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT, COLUMN_KEY, TABLE_SCHEMA
  FROM information_schema.COLUMNS
 WHERE TABLE_NAME = ? AND (? = '' OR TABLE_SCHEMA = ?)
   AND TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
 ORDER BY TABLE_SCHEMA, ORDINAL_POSITION LIMIT ${FACTS_ROWS}`;
// UNVERIFIED: InnoDB's TABLE_ROWS is a sample; a view has TABLE_COMMENT 'VIEW' and no sizes.
const TABLES_SQL = `SELECT TABLE_COMMENT, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, UPDATE_TIME
  FROM information_schema.TABLES WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ? LIMIT 1`;
const STATISTICS_SQL = `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE
  FROM information_schema.STATISTICS WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ?
 ORDER BY INDEX_NAME, SEQ_IN_INDEX LIMIT 500`;
const PARTITIONS_SQL = `SELECT PARTITION_METHOD, PARTITION_EXPRESSION
  FROM information_schema.PARTITIONS WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ? AND PARTITION_NAME IS NOT NULL LIMIT 1`;

/** `to_days(\`order_date\`)` → ['order_date']; no backticks → the expression as written. */
function partitionColumns(expression: string): string[] {
  const named = [...expression.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return named.length ? named : expression.trim() ? [expression.trim()] : [];
}

async function readFacts(q: FactsQuery, schemaGiven: string, name: string): Promise<FactsReply> {
  const all = await q(COLUMNS_SQL, [name, schemaGiven, schemaGiven]); // required: a refusal propagates
  // With no schema to look in, rows from several schemas can answer; the first schema's table is the one.
  const schema = str(all[0]?.[5]) || schemaGiven;
  const rows = all.filter((r) => (str(r[5]) || schema) === schema);
  const columns: FactColumn[] = rows.map((r) => {
    const col: FactColumn = { name: str(r[0]), type: str(r[1]) };
    if (flag(r[2]) !== undefined) col.nullable = flag(r[2]) as boolean;
    if (str(r[3])) col.comment = str(r[3]);
    if (str(r[4]) === 'PRI') col.key = true;
    return col;
  }).filter((c) => c.name);
  if (columns.length === 0) return { ok: false, error: `No such table: ${name}` };
  const facts: { ok: true } & TableFacts = { ok: true, columns };
  const bound: FactParam[] = [name, schema];

  const table = (await attempt(q, TABLES_SQL, bound))?.[0];
  if (table) {
    const comment = str(table[0]);
    if (comment && comment !== 'VIEW' && !comment.startsWith('InnoDB free:')) facts.comment = comment;
    const estimate = figure(table[1]);
    if (estimate !== undefined) facts.rowEstimate = Math.round(estimate);
    const bytes = figure(table[2]);
    if (bytes !== undefined) facts.bytes = bytes;
    // dateStrings: 'YYYY-MM-DD HH:MM:SS' in the server's zone. A 'T' makes it parse everywhere; the zone is not ours to invent.
    const modified = str(table[3]).replace(' ', 'T');
    if (modified) facts.lastModified = modified;
  }

  const stats = await attempt(q, STATISTICS_SQL, bound);
  if (stats?.length) {
    const key = stats.filter((r) => str(r[0]) === 'PRIMARY').map((r) => str(r[1])).filter(Boolean);
    if (key.length) facts.primaryKey = { columns: key, enforced: true };
    const indexes = foldIndexes(stats.filter((r) => str(r[0]) !== 'PRIMARY')
      .map((r) => ({ name: str(r[0]), column: str(r[1]), unique: str(r[2]) === '0', kind: str(r[3]) })));
    if (indexes.length) facts.indexes = indexes;
  }

  const part = (await attempt(q, PARTITIONS_SQL, bound))?.[0];
  const partCols = part ? partitionColumns(str(part[1])) : [];
  if (part && partCols.length) facts.partition = { columns: partCols, ...(str(part[0]) ? { method: str(part[0]).toUpperCase() } : {}) };
  return facts;
}

/** Parses `table` first (at most two parts, none empty): a bad name never opens a connection. The schema is the qualifier, else `database`. */
export function mysqlTableFacts(table: string, open: OpenFacts, opts: { database: string }): Promise<FactsReply> {
  const parts = nameParts(table, 2);
  if (!parts) return Promise.resolve({ ok: false, error: 'Invalid table name' });
  return open((q) => readFacts(q, parts.length === 2 ? parts[0] : opts.database, parts[parts.length - 1]));
}
