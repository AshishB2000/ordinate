// Incremental refresh — the cursor predicate, pushed to the source per dialect.
// MAIN PROCESS, pure: builds a string, runs nothing.
//
// `select * from <the dataset's table or query> where <cursor> >= <lower bound>`,
// handed to the connector as a query, so the connector's OWN server-side row
// cap still wraps it exactly as it wraps every other statement (rule 3 of
// types.ts). There is no central wrapper — that broke five of six dialects — so
// each family below says how it quotes a column and spells a literal.
//
// The pushed predicate is a SUPERSET filter, never the exact one. The exact cut
// is made after the fetch, in JS, on the column's declared type
// (incremental.filterBatch), so the server only has to never drop a row that
// should come back:
//   • dates are widened by a day, which absorbs how each engine interprets a
//     zone-less literal against a zoned column;
//   • DuckDB (the folder and file connectors) reads CSV cells as text, so the
//     cursor is TRY_CAST and a cell that does not cast passes through to JS;
//   • a predicate the source rejects (a cursor stored as text in Postgres, say)
//     is retried without one by the caller, and the run is logged as filtered
//     after fetch.
//
// Values are LITERALS, not bound parameters: `ConnectorDef.run(ctx, sql)` takes
// one statement and no binds, and widening that contract across 35 sources for
// one number is not worth it. The literal is safe by construction — a finite
// number printed by JS, or an ISO timestamp printed by Date — never user text.
// Identifiers are quoted with each dialect's own doubling.
//
// HTTP engines, SaaS APIs and the URL source get null: the caller fetches as
// today and filters after the fetch, and the UI says so.

import { quotedTable } from './connectionRun';

const DAY_MS = 86_400_000;

interface Dialect {
  col: (name: string) => string;
  ts: (isoSeconds: string) => string;
  /** Wrap a cursor comparison; DuckDB's casts a text cell first. */
  cmp: (col: string, type: 'number' | 'date', lit: string) => string;
}

const dq = (n: string): string => '"' + n.replace(/"/g, '""') + '"';
// BigQuery escapes inside a backtick identifier with a backslash, not by doubling.
const bq = (n: string): string => '`' + n.replace(/[\\`]/g, (c) => '\\' + c).replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '`';
const plain = (col: string, _t: 'number' | 'date', lit: string): string => `${col} >= ${lit}`;
const ansiTs = (s: string): string => `TIMESTAMP '${s.replace('T', ' ')}'`;

const DIALECTS: Readonly<Record<string, Dialect>> = {
  postgres: { col: dq, ts: ansiTs, cmp: plain },
  oracle: { col: dq, ts: ansiTs, cmp: plain },
  mysql: { col: (n) => '`' + n.replace(/`/g, '``') + '`', ts: ansiTs, cmp: plain },
  mssql: { col: (n) => '[' + n.replace(/]/g, ']]') + ']', ts: (s) => `CAST('${s}' AS DATETIME2)`, cmp: plain },
  // BigQuery will not compare a DATE or DATETIME column with a TIMESTAMP (no
  // implicit coercion), and DATE is the usual partition column. An untyped
  // string literal IS coerced to the column's own type — DATE, DATETIME or
  // TIMESTAMP alike — so the cursor is the literal's day: one more day of
  // superset, and the bare column keeps partition pruning.
  bigquery: { col: bq, ts: (s) => `'${s.slice(0, 10)}'`, cmp: plain },
  duckdb: {
    col: dq,
    ts: ansiTs,
    cmp: (col, type, lit) => {
      const cast = `TRY_CAST(${col} AS ${type === 'number' ? 'DOUBLE' : 'TIMESTAMP'})`;
      return `(${cast} IS NULL OR ${cast} >= ${lit})`;
    },
  },
};

/** The families that can take a pushed predicate. */
export function canPush(family: string): boolean {
  return Object.prototype.hasOwnProperty.call(DIALECTS, family);
}

/**
 * The statement an incremental run sends, or null when this source cannot take
 * the predicate (the caller then filters after the fetch). `lowerKey` is the
 * cursor key of the lower bound: the number itself, or epoch ms for a date.
 */
export function pushdownSql(
  family: string,
  selection: { table?: string; query?: string },
  column: string,
  type: 'number' | 'date',
  lowerKey: number,
): string | null {
  const d = DIALECTS[family];
  if (!d || !column || !Number.isFinite(lowerKey)) return null;

  let lit: string;
  if (type === 'number') {
    lit = String(lowerKey);
  } else {
    const t = lowerKey - DAY_MS;
    if (t < Date.UTC(1, 0, 1) || t > Date.UTC(9999, 11, 30)) return null;
    lit = d.ts(new Date(t).toISOString().slice(0, 19));
  }
  const where = d.cmp(d.col(column), type, lit);

  const query = typeof selection.query === 'string' ? selection.query.trim().replace(/;\s*$/, '') : '';
  if (query) {
    // T-SQL refuses an ORDER BY or a CTE inside a derived table (mssql.ts,
    // capTsql). Rather than rewrite the user's statement, do not push.
    if (family === 'mssql' && (/^\s*with\b/i.test(query) || /\border\s+by\b/i.test(query))) return null;
    // No `AS` (Oracle refuses it for a table alias) and no leading underscore
    // (Oracle refuses that in an unquoted name).
    return `select * from ( ${query} ) ord_inc where ${where}`;
  }
  const table = typeof selection.table === 'string' ? quotedTable(family, selection.table) : null;
  return table ? `select * from ${table} where ${where}` : null;
}
