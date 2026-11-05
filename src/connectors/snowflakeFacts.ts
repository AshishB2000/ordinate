// A table's facts out of Snowflake's SHOW statements (docs/semantic-layer/02-source-tables.md, D6, D7):
// comments, columns with types, clustering, the informational primary key, the row count and size.
// MAIN PROCESS ONLY, but it imports no driver: snowflake.ts hands it `open` and a query function that
// runs each statement through the SQL API, guarded, bounded and redacted, and answers the rows.
//
// UNVERIFIED: every statement and every column of its answer is written from Snowflake's documentation and
// answered in the self-checks by a fixture. SHOW runs on cloud services and so should need no running
// warehouse: scripts/warehouseLiveSnowflake.ts (the nightly) reads facts with the warehouse unset on a real
// account to find out. If it fails there, read INFORMATION_SCHEMA instead (bound, like describeTable) and set
// `factsWake` on the connector, as for Databricks.
//
// SHOW takes no binds, so every part of the name must be a plain identifier (IDENT_RE) and is double-quoted,
// which keeps the case it is stored in (D2). Because SHOW's columns have no stable positions, the first row
// of each answer is the column names, lower-cased; a reader finds a field by name. SHOW COLUMNS and SHOW
// PRIMARY KEYS take no LIMIT (UNVERIFIED): the connector's own row cap bounds what is kept. SHOW TABLES does.

import { attempt, figure, flag, nameParts, records, splitTop, str } from './factsRead';
import type { FactColumn, FactsQuery, FactsReply, OpenFacts, TableFacts } from './tableFacts';

/** A part of a name that may be quoted without escaping: letters, digits, `_` and `$`, not starting with a digit. */
export const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;
const SHOW_TABLES_ROWS = 50;

/** `data_type` is JSON text: {"type":"FIXED","precision":38,"scale":0,...}. NUMBER(p,s) and the rest as describeTable spells them. */
function typeOf(raw: unknown): string {
  const text = str(raw);
  try {
    const t = JSON.parse(text) as { type?: unknown; precision?: unknown; scale?: unknown };
    const type = str(t.type).toUpperCase();
    if (!type) return text;
    if (type === 'FIXED') return `NUMBER(${str(t.precision) || '38'},${str(t.scale) || '0'})`;
    return type === 'REAL' ? 'FLOAT' : type;
  } catch {
    return text;
  }
}

/** `LINEAR(ORDER_DATE, REGION)` → ['ORDER_DATE', 'REGION']; an expression in it is kept as written. */
function clusterColumns(raw: string): string[] {
  const m = /^\s*(?:\w+\s*)?\(([\s\S]*)\)\s*$/.exec(raw);
  return m ? splitTop(m[1]) : [];
}

async function readFacts(q: FactsQuery, parts: string[]): Promise<FactsReply> {
  const quoted = parts.map((p) => `"${p}"`);
  const table = quoted.join('.');
  const name = parts[parts.length - 1];
  const raw = await q(`SHOW COLUMNS IN TABLE ${table}`, []); // required: a refusal propagates
  const columns: FactColumn[] = records(raw).map((r) => {
    const col: FactColumn = { name: str(r.column_name), type: typeOf(r.data_type) };
    if (flag(r['null?']) !== undefined) col.nullable = flag(r['null?']) as boolean;
    if (str(r.comment)) col.comment = str(r.comment);
    return col;
  }).filter((c) => c.name);
  if (columns.length === 0) return { ok: false, error: `No such table: ${name}` };
  const facts: { ok: true } & TableFacts = { ok: true, columns };

  // LIKE is case-insensitive and `_` is a wildcard in it: the row whose name is exactly this part is the table.
  const schema = quoted.length > 1 ? ` IN SCHEMA ${quoted.slice(0, -1).join('.')}` : '';
  const row = records(await attempt(q, `SHOW TABLES LIKE '${name}'${schema} LIMIT ${SHOW_TABLES_ROWS}`, [])).find((r) => str(r.name) === name);
  if (row) {
    if (str(row.comment)) facts.comment = str(row.comment);
    const cluster = clusterColumns(str(row.cluster_by));
    if (cluster.length) facts.clusterBy = cluster;
    const rows = figure(row.rows);
    if (rows !== undefined) facts.rowEstimate = Math.round(rows);
    const bytes = figure(row.bytes);
    if (bytes !== undefined) facts.bytes = bytes;
  }

  const key = records(await attempt(q, `SHOW PRIMARY KEYS IN TABLE ${table}`, []))
    .sort((a, b) => Number(a.key_sequence) - Number(b.key_sequence)).map((r) => str(r.column_name)).filter(Boolean);
  if (key.length) {
    facts.primaryKey = { columns: key, enforced: false }; // Snowflake does not enforce a primary key
    for (const c of columns) if (key.includes(c.name)) c.key = true;
  }
  return facts;
}

/** Parses `table` first (one to three parts, each an identifier): a name that fails never opens a connection. */
export function snowflakeTableFacts(table: string, open: OpenFacts): Promise<FactsReply> {
  const parts = nameParts(table, 3);
  if (!parts || !parts.every((p) => IDENT_RE.test(p))) return Promise.resolve({ ok: false, error: 'Invalid table name' });
  return open((q) => readFacts(q, parts));
}
