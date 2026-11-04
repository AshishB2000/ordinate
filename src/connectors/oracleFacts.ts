// A table's facts out of Oracle's data dictionary (docs/semantic-layer/02-source-tables.md, D6, D7): comments,
// columns with types, the primary key and indexes, the partition key, the optimizer's row estimate and the date
// it was last gathered. MAIN PROCESS ONLY, but it imports no driver: oracle.ts hands it `open`, which connects
// (thin mode, guarded, SSRF-pinned) and closes, and a query function.
//
// UNVERIFIED: every statement is written from the Oracle documentation and answered in the self-checks by a
// fixture; nothing has run on Oracle Database or Autonomous. Only ALL_TAB_COLUMNS is required; each of the rest
// costs its field. There is no size: ALL_SEGMENTS does not exist and DBA_SEGMENTS needs a DBA grant.
//
// Every value is a bind: `:1` the table, `:2` the owner (NULL until the columns say who owns it) and `:3` the
// row limit of `FETCH FIRST :3 ROWS ONLY`, which ends every statement. Oracle folds an unquoted name to upper
// case, so the name as given is tried first and its upper-case twin second (describeTable does the same): a
// quoted lower-case table wins when it exists.

import { attempt, figure, flag, foldIndexes, nameParts, str, type FactParam } from './factsRead';
import { FACTS_ROWS, type FactColumn, type FactsQuery, type FactsReply, type OpenFacts, type TableFacts } from './tableFacts';

const COLUMNS_SQL = `SELECT column_name, data_type, nullable, owner
  FROM all_tab_columns
 WHERE table_name = :1 AND (:2 IS NULL OR owner = :2)
 ORDER BY owner, column_id
 FETCH FIRST :3 ROWS ONLY`;
const TAB_COMMENT_SQL = `SELECT comments FROM all_tab_comments WHERE table_name = :1 AND owner = :2 FETCH FIRST :3 ROWS ONLY`;
const COL_COMMENTS_SQL = `SELECT column_name, comments FROM all_col_comments
 WHERE table_name = :1 AND owner = :2 AND comments IS NOT NULL
 ORDER BY column_name FETCH FIRST :3 ROWS ONLY`;
// UNVERIFIED: status is ENABLED or DISABLED; index_name is the index that backs the key (NULL when there is none).
const KEY_SQL = `SELECT cc.column_name, cc.position, c.status, c.index_name
  FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
 WHERE c.constraint_type = 'P' AND c.table_name = :1 AND c.owner = :2
 ORDER BY cc.position FETCH FIRST :3 ROWS ONLY`;
// UNVERIFIED: uniqueness is UNIQUE or NONUNIQUE; index_type is NORMAL, BITMAP, FUNCTION-BASED NORMAL and the rest.
const INDEXES_SQL = `SELECT i.index_name, i.uniqueness, i.index_type, ic.column_name, ic.column_position
  FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
 WHERE i.table_name = :1 AND i.table_owner = :2
 ORDER BY i.index_name, ic.column_position FETCH FIRST :3 ROWS ONLY`;
// UNVERIFIED: partitioning_type is RANGE, LIST, HASH, SYSTEM or REFERENCE; a REFERENCE or SYSTEM table has no key columns.
const PARTITION_SQL = `SELECT p.partitioning_type, k.column_name, k.column_position
  FROM all_part_tables p JOIN all_part_key_columns k ON k.owner = p.owner AND k.name = p.table_name AND k.object_type = 'TABLE'
 WHERE p.table_name = :1 AND p.owner = :2
 ORDER BY k.column_position FETCH FIRST :3 ROWS ONLY`;
// UNVERIFIED: num_rows and last_analyzed are NULL until statistics are gathered.
const TABLE_SQL = `SELECT num_rows, last_analyzed FROM all_tables WHERE table_name = :1 AND owner = :2 FETCH FIRST :3 ROWS ONLY`;

const INDEX_ROWS = 500, KEY_ROWS = 32;

async function readFacts(q: FactsQuery, ownerGiven: string, name: string): Promise<FactsReply> {
  // Verbatim, then the upper-case twin. Two cheap catalog reads beat guessing which convention made the table.
  let lookup: [string, string | null] = [name, ownerGiven || null];
  let all = await q(COLUMNS_SQL, [lookup[0], lookup[1], FACTS_ROWS]); // required: a refusal propagates
  const upper: [string, string | null] = [name.toUpperCase(), ownerGiven ? ownerGiven.toUpperCase() : null];
  if (all.length === 0 && (upper[0] !== lookup[0] || upper[1] !== lookup[1])) {
    lookup = upper;
    all = await q(COLUMNS_SQL, [lookup[0], lookup[1], FACTS_ROWS]);
  }
  // With no owner named, several owners can answer; the first owner's table is the one.
  const owner = str(all[0]?.[3]) || lookup[1] || '';
  const columns: FactColumn[] = all.filter((r) => (str(r[3]) || owner) === owner).map((r) => {
    const col: FactColumn = { name: str(r[0]), type: str(r[1]) };
    if (flag(r[2]) !== undefined) col.nullable = flag(r[2]) as boolean; // 'Y' / 'N'
    return col;
  }).filter((c) => c.name);
  if (columns.length === 0) return { ok: false, error: `No such table: ${name}` };
  const facts: { ok: true } & TableFacts = { ok: true, columns };
  const bind = (rows: number): FactParam[] => [lookup[0], owner, rows];

  const tabComment = str((await attempt(q, TAB_COMMENT_SQL, bind(1)))?.[0]?.[0]);
  if (tabComment) facts.comment = tabComment;
  for (const r of (await attempt(q, COL_COMMENTS_SQL, bind(FACTS_ROWS))) ?? []) {
    const col = columns.find((c) => c.name === str(r[0]));
    if (col && str(r[1])) col.comment = str(r[1]);
  }

  const key = await attempt(q, KEY_SQL, bind(KEY_ROWS));
  const keyColumns = (key ?? []).map((r) => str(r[0])).filter(Boolean);
  if (key && keyColumns.length) {
    facts.primaryKey = { columns: keyColumns, enforced: str(key[0][2]) === 'ENABLED' };
    for (const c of columns) if (keyColumns.includes(c.name)) c.key = true;
  }
  const keyIndex = str(key?.[0]?.[3]); // the index that backs the key is the key, not a second fact
  const indexes = foldIndexes(((await attempt(q, INDEXES_SQL, bind(INDEX_ROWS))) ?? []).filter((r) => str(r[0]) !== keyIndex)
    .map((r) => ({ name: str(r[0]), column: str(r[3]), unique: str(r[1]) === 'UNIQUE', kind: str(r[2]) })));
  if (indexes.length) facts.indexes = indexes;

  const part = await attempt(q, PARTITION_SQL, bind(KEY_ROWS));
  const partColumns = (part ?? []).map((r) => str(r[1])).filter(Boolean);
  if (part?.length && partColumns.length) facts.partition = { columns: partColumns, method: str(part[0][0]).toUpperCase() || undefined };

  const table = (await attempt(q, TABLE_SQL, bind(1)))?.[0];
  if (table) {
    const estimate = figure(table[0]);
    if (estimate !== undefined) facts.rowEstimate = Math.round(estimate);
    const analysed = table[1] instanceof Date ? table[1].toISOString() : str(table[1]); // the driver's DATE, or its ISO text
    if (analysed) facts.lastModified = analysed;
  }
  return facts;
}

/** Parses `table` first (at most two parts, none empty): a bad name never opens a connection. */
export function oracleTableFacts(table: string, open: OpenFacts): Promise<FactsReply> {
  const parts = nameParts(table, 2);
  if (!parts) return Promise.resolve({ ok: false, error: 'Invalid table name' });
  return open((q) => readFacts(q, parts.length === 2 ? parts[0] : '', parts[parts.length - 1]));
}
