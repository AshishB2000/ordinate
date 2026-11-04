// A table's facts out of the SQL Server family's catalog (docs/semantic-layer/02-source-tables.md, D6, D7):
// descriptions (MS_Description), columns with types, the primary key and indexes, the partition key, the
// row estimate and size; on an Azure Synapse dedicated pool the distribution too. MAIN PROCESS ONLY, but it
// imports no driver: mssql.ts hands it `open`, which connects (guarded, SSRF-pinned) and closes, and a query
// function that binds the positional params as @p0, @p1.
//
// UNVERIFIED: every statement is written from the SQL Server, Azure SQL and Synapse documentation and
// answered in the self-checks by a fixture; nothing has run on a real server. Only COLUMNS is required;
// every other read costs its field (VIEW DATABASE STATE is commonly withheld, and a Synapse pool lacks
// several of the views a SQL Server has).
//
// @p0 is the schema (blank for an unqualified name, until the columns say which schema has the table) and
// @p1 the table: bound values, quoted server-side by QUOTENAME for OBJECT_ID, never text. Every statement
// is `SELECT TOP (n)`, with n a constant of this file.

import { attempt, figure, flag, foldIndexes, nameParts, str, type FactParam } from './factsRead';
import { FACTS_ROWS, type FactColumn, type FactsQuery, type FactsReply, type OpenFacts, type TableFacts } from './tableFacts';

const OBJECT = `OBJECT_ID(QUOTENAME(@p0) + N'.' + QUOTENAME(@p1))`;
const INDEX_ROWS = 500;

const COLUMNS_SQL = `SELECT TOP (${FACTS_ROWS}) COLUMN_NAME, DATA_TYPE, IS_NULLABLE, TABLE_SCHEMA
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME = @p1 AND (@p0 = N'' OR TABLE_SCHEMA = @p0)
 ORDER BY TABLE_SCHEMA, ORDINAL_POSITION`;
// UNVERIFIED: class 1 is an object or column, minor_id 0 the object itself and any other the column_id.
const COMMENTS_SQL = `SELECT TOP (${FACTS_ROWS}) ep.minor_id, c.name, CAST(ep.value AS NVARCHAR(2000))
  FROM sys.extended_properties ep LEFT JOIN sys.columns c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id
 WHERE ep.class = 1 AND ep.name = N'MS_Description' AND ep.major_id = ${OBJECT}`;
// UNVERIFIED: type_desc names the kind ('CLUSTERED COLUMNSTORE' among them); partition_ordinal > 0 marks a partitioning
// column. A heap has no row (type 0). An included column is not part of the key, except in a columnstore index (types 5, 6).
const INDEXES_SQL = `SELECT TOP (${INDEX_ROWS}) i.name, i.is_primary_key, i.is_unique, i.type_desc, c.name, ic.key_ordinal, ic.partition_ordinal
  FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
 WHERE i.object_id = ${OBJECT} AND i.type > 0 AND (ic.is_included_column = 0 OR i.type IN (5, 6))
 ORDER BY i.index_id, ic.key_ordinal`;
// UNVERIFIED: row_count counts the heap or clustered index once (index_id 0, 1); a size is a count of 8 KB pages,
// summed as BIGINT because a table past 2 GB overflows an INT. Often refused: no VIEW DATABASE STATE.
const SIZE_SQL = `SELECT TOP (1) SUM(CASE WHEN index_id IN (0, 1) THEN row_count ELSE 0 END), CAST(SUM(used_page_count) AS BIGINT) * 8192
  FROM sys.dm_db_partition_stats WHERE object_id = ${OBJECT}`;
const EDITION_SQL = `SELECT SERVERPROPERTY('EngineEdition')`;
const DEDICATED_POOL = 6; // 11 is a serverless pool, which has no pdw views; anything else is not Synapse
// UNVERIFIED: the policy is HASH, ROUND_ROBIN or REPLICATE; only HASH names a column (a second one in the newer multi-column form).
const DISTRIBUTION_SQL = `SELECT TOP (33) d.distribution_policy_desc, c.name
  FROM sys.pdw_table_distribution_properties d
  LEFT JOIN sys.pdw_column_distribution_properties p ON p.object_id = d.object_id AND p.distribution_ordinal > 0
  LEFT JOIN sys.columns c ON c.object_id = p.object_id AND c.column_id = p.column_id
 WHERE d.object_id = ${OBJECT}
 ORDER BY p.distribution_ordinal`;

async function readFacts(q: FactsQuery, schemaGiven: string, name: string, synapse: boolean): Promise<FactsReply> {
  const all = await q(COLUMNS_SQL, [schemaGiven, name]); // required: a refusal propagates
  // With no schema named, rows from several schemas can answer; the first schema's table is the one.
  const schema = str(all[0]?.[3]) || schemaGiven;
  const columns: FactColumn[] = all.filter((r) => (str(r[3]) || schema) === schema).map((r) => {
    const col: FactColumn = { name: str(r[0]), type: str(r[1]) };
    if (flag(r[2]) !== undefined) col.nullable = flag(r[2]) as boolean;
    return col;
  }).filter((c) => c.name);
  if (columns.length === 0) return { ok: false, error: `No such table: ${name}` };
  const facts: { ok: true } & TableFacts = { ok: true, columns };
  const bound: FactParam[] = [schema, name];

  const comments = await attempt(q, COMMENTS_SQL, bound);
  for (const r of comments ?? []) {
    const text = str(r[2]);
    if (!text) continue;
    if (Number(r[0]) === 0) facts.comment = text;
    else { const col = columns.find((c) => c.name === str(r[1])); if (col) col.comment = text; }
  }

  const rows = await attempt(q, INDEXES_SQL, bound);
  if (rows?.length) {
    const key = rows.filter((r) => flag(r[1]) === true).map((r) => str(r[4])).filter(Boolean);
    if (key.length) {
      facts.primaryKey = { columns: key, enforced: !synapse }; // a Synapse key is NOT ENFORCED
      for (const c of columns) if (key.includes(c.name)) c.key = true;
    }
    const indexes = foldIndexes(rows.filter((r) => flag(r[1]) !== true).map((r) => ({ name: str(r[0]), column: str(r[4]), unique: flag(r[2]) === true, kind: str(r[3]) })));
    if (indexes.length) facts.indexes = indexes;
    const partitioned = rows.filter((r) => Number(r[6]) > 0).sort((a, b) => Number(a[6]) - Number(b[6])).map((r) => str(r[4]));
    const partition = [...new Set(partitioned)];
    if (partition.length) facts.partition = { columns: partition, method: 'RANGE' };
  }

  const size = (await attempt(q, SIZE_SQL, bound))?.[0];
  if (size) {
    const estimate = figure(size[0]);
    if (estimate !== undefined) facts.rowEstimate = Math.round(estimate);
    const bytes = figure(size[1]);
    if (bytes !== undefined) facts.bytes = bytes;
  }

  if (synapse && Number((await attempt(q, EDITION_SQL, []))?.[0]?.[0]) === DEDICATED_POOL) {
    const dist = await attempt(q, DISTRIBUTION_SQL, bound);
    const style = str(dist?.[0]?.[0]);
    if (style) facts.distribution = { style, columns: [...new Set((dist ?? []).map((r) => str(r[1])).filter(Boolean))] };
  }
  return facts;
}

/** Parses `table` first (at most two parts, none empty): a bad name never opens a connection. `synapse` is the azure-synapse variant. */
export function mssqlTableFacts(table: string, open: OpenFacts, opts: { synapse: boolean }): Promise<FactsReply> {
  const parts = nameParts(table, 2);
  if (!parts) return Promise.resolve({ ok: false, error: 'Invalid table name' });
  return open((q) => readFacts(q, parts.length === 2 ? parts[0] : '', parts[parts.length - 1], opts.synapse));
}
