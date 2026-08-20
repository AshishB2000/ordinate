// Connection dispatch — MAIN PROCESS ONLY.
//
// This used to BE the two data sources: a hardcoded pgListTables/pgRun/urlRun
// switch. It is now the layer that resolves a stored `connectorId` to its
// ConnectorDef (src/connectors), builds the one ConnectorContext that carries the
// bounds every connector must honour, and folds whatever comes back into the
// ParseResult the Datasets → Visuals pipeline already consumes. Adding a source
// does not touch this file.
//
// It holds NO secrets and touches NO Electron config — the IPC layer resolves the
// password / token and passes it in. No fs. Every function returns a
// discriminated {ok:true,...} | {ok:false,error}, and EVERY error path goes
// through safeError(), so a driver string carrying a DSN or a password is
// redacted before it can reach a renderer.

import { finalizeTable, ParseResult } from '../data/parse';
import { getConnector } from './index';
import { safeError } from './types';
import type { ConnectorColumn, ConnectorContext, ConnectorDef } from './types';

// The bounds fed into every ConnectorContext. Unchanged from the pre-registry
// runner: the same 1M row cap as the file path (parse.ts MAX_ROWS) and the same
// 30s statement timeout Postgres has always run under. A connector MUST apply
// both — see contract rule 3 — which is why they are passed rather than assumed.
export const ROW_LIMIT = 1_000_000;
export const QUERY_TIMEOUT_MS = 30_000;

export interface RunBounds {
  rowLimit?: number;
  timeoutMs?: number;
}

type RunOk = { ok: true; result: ParseResult; truncated: boolean };
type RunErr = { ok: false; error: string };
type TablesOk = { ok: true; tables: { schema?: string; name: string }[] };

/** Build the per-call context. Bounds are clamped to the module defaults — a
 *  caller may ask for LESS, never more, so no call site can quietly uncap. */
export function buildContext(
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  bounds?: RunBounds,
): ConnectorContext {
  const wantRows = Number(bounds?.rowLimit);
  const wantMs = Number(bounds?.timeoutMs);
  return {
    values: values && typeof values === 'object' ? values : {},
    secrets: secrets && typeof secrets === 'object' ? secrets : {},
    rowLimit: Number.isFinite(wantRows) && wantRows > 0 ? Math.min(wantRows, ROW_LIMIT) : ROW_LIMIT,
    timeoutMs: Number.isFinite(wantMs) && wantMs > 0 ? Math.min(wantMs, QUERY_TIMEOUT_MS) : QUERY_TIMEOUT_MS,
  };
}

function resolve(connectorId: unknown): ConnectorDef | null {
  return getConnector(connectorId);
}

// ── Table → SQL ──────────────────────────────────────────────────────────────
//
// A saved TABLE is turned into SQL here, once, rather than six times in six
// family modules. A saved QUERY is passed through untouched (minus a trailing
// semicolon): it is the user's own SQL against their own database, and rewriting
// it for six dialects is how you break five of them. Bounding a user query is the
// connector's job — ctx.rowLimit is not advisory.

// An identifier we are willing to interpolate. Identifiers cannot be bound
// parameters, so this whitelist IS the injection guard: leading letter or
// underscore, then letters/digits/_/$. Unchanged from the pg-only runner.
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

// Per-family identifier quoting + row-limit syntax. Only the five families this
// app ships are listed; anything else gets ANSI double quotes and LIMIT, which is
// what Postgres, DuckDB, ClickHouse, Trino and Presto all accept.
interface Dialect {
  quote: (part: string) => string;
  limit: (sql: string, n: number) => string;
}
const ANSI: Dialect = {
  quote: (p) => '"' + p.replace(/"/g, '""') + '"',
  limit: (sql, n) => `${sql} limit ${n}`,
};
const DIALECTS: Readonly<Record<string, Dialect>> = {
  mysql: {
    quote: (p) => '`' + p.replace(/`/g, '``') + '`',
    limit: (sql, n) => `${sql} limit ${n}`,
  },
  mssql: {
    quote: (p) => '[' + p.replace(/]/g, ']]') + ']',
    // T-SQL has no LIMIT; TOP goes in the projection.
    limit: (sql, n) => sql.replace(/^select \*/i, `select top ${n} *`),
  },
  oracle: {
    // Deliberately NOT quoted: Oracle folds an unquoted identifier to upper case,
    // so quoting a user's `sales` would look for a lower-case table that almost
    // never exists. The IDENT_RE whitelist is what makes bare interpolation safe.
    quote: (p) => p,
    limit: (sql, n) => `${sql} fetch first ${n} rows only`,
  },
};

/** Compile a validated `schema.table` (or `db.schema.table`) into a bounded
 *  SELECT for this family. Returns null when the name fails the whitelist. */
export function buildTableSql(family: string, table: string, rowLimit: number): string | null {
  const parts = String(table || '').trim().split('.');
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !IDENT_RE.test(p))) return null;
  const dialect = DIALECTS[family] || ANSI;
  const quoted = parts.map(dialect.quote).join('.');
  return dialect.limit(`select * from ${quoted}`, rowLimit);
}

/** The SQL a saved selection runs, or an error string. Exported for the
 *  self-check — the mapping from a stored table/query to a statement is the one
 *  piece of dispatch worth pinning down. */
export function selectionSql(
  def: ConnectorDef,
  selection: { table?: string; query?: string },
  rowLimit: number,
): { ok: true; sql: string } | RunErr {
  const table = typeof selection?.table === 'string' ? selection.table.trim() : '';
  const query = typeof selection?.query === 'string' ? selection.query.trim() : '';
  if (query) {
    // Their DB, their SQL. A trailing semicolon breaks a connector that wraps or
    // parameterises the statement, so strip it — the only edit we make.
    return { ok: true, sql: query.replace(/;\s*$/, '') };
  }
  if (table) {
    const sql = buildTableSql(def.family, table, rowLimit);
    return sql ? { ok: true, sql } : { ok: false, error: 'Invalid table name' };
  }
  // A source with no table picker and no SQL (the URL connector) still runs —
  // it ignores the statement entirely. Only SQL families need a selection.
  if ((def.fields || []).some((f) => f.key === 'url')) return { ok: true, sql: '' };
  return { ok: false, error: 'No table or query specified' };
}

// ── ConnectorRows → ParseResult ──────────────────────────────────────────────

// Stringify a driver cell for finalizeTable (which type-detects over strings,
// exactly like the CSV/JSON path). null → '' (empty), Date → ISO, object → JSON.
function cellToString(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString(); // COUNT(*) arrives as BigInt
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// The source's own column types are deliberately DISCARDED here: parse.ts's
// detector is what decides whether `007` is a number, and it must decide the same
// way for a database column as for a CSV column, or the same data would type
// differently depending on where it came from.
function toParseResult(
  columns: ConnectorColumn[],
  rows: (string | number | boolean | null)[][],
  truncated: boolean,
  rowLimit: number,
): ParseResult {
  const header = (columns || []).map((c) => String(c?.name ?? ''));
  const body = (rows || []).map((row) => (row || []).map(cellToString));
  const result = finalizeTable(header, body);
  if (truncated) {
    result.warnings = result.warnings.concat(
      `Result truncated at ${rowLimit.toLocaleString('en-US')} rows.`,
    );
  }
  return result;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** List a source's tables. Sources without a table picker return an empty list —
 *  that is an answer, not a failure. */
export async function listTables(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  bounds?: RunBounds,
): Promise<TablesOk | RunErr> {
  const def = resolve(connectorId);
  if (!def) return { ok: false, error: unknownConnector(connectorId) };
  const ctx = buildContext(values, secrets, bounds);
  try {
    const res = await def.listTables(ctx);
    if (!res.ok) return { ok: false, error: safeError(res.error, ctx.secrets) };
    const tables = (res.tables || []).map((t) => ({
      schema: typeof t?.schema === 'string' ? t.schema : undefined,
      name: String(t?.name ?? ''),
    }));
    return { ok: true, tables };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

/** Run a saved selection (table or query) and fold the result into a
 *  ParseResult — the same shape the CSV / JSON / xlsx paths produce. */
export async function runConnection(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  selection: { table?: string; query?: string },
  bounds?: RunBounds,
): Promise<RunOk | RunErr> {
  const def = resolve(connectorId);
  if (!def) return { ok: false, error: unknownConnector(connectorId) };
  const ctx = buildContext(values, secrets, bounds);

  const sql = selectionSql(def, selection || {}, ctx.rowLimit);
  if (!sql.ok) return sql;

  try {
    const res = await def.run(ctx, sql.sql);
    if (!res.ok) return { ok: false, error: safeError(res.error, ctx.secrets) };
    const truncated = res.truncated === true || (res.rows || []).length > ctx.rowLimit;
    const rows = (res.rows || []).slice(0, ctx.rowLimit); // trust, then verify
    return {
      ok: true,
      result: toParseResult(res.columns || [], rows, truncated, ctx.rowLimit),
      truncated,
    };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

/** Reachability check used by connection:testAndSave. Prefers listTables (cheap,
 *  and it populates the table picker); falls back to running the selection for a
 *  source that has no table list, like URL/API. */
export async function testConnection(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  selection?: { table?: string; query?: string },
  bounds?: RunBounds,
): Promise<{ ok: true; tables: { schema?: string; name: string }[] } | RunErr> {
  const def = resolve(connectorId);
  if (!def) return { ok: false, error: unknownConnector(connectorId) };

  const listed = await listTables(connectorId, values, secrets, bounds);
  if (!listed.ok) return listed;
  if (listed.tables.length > 0) return listed;

  // Nothing to enumerate. If there is also nothing to run — a SQL source whose
  // database is genuinely empty — listTables having succeeded IS the proof that
  // the credentials work; do not manufacture a failure.
  const ctx = buildContext(values, secrets, bounds);
  if (!selectionSql(def, selection || {}, ctx.rowLimit).ok) return listed;

  // Otherwise prove reachability by actually fetching (this is the URL/API path).
  const run = await runConnection(connectorId, values, secrets, selection || {}, bounds);
  return run.ok ? { ok: true, tables: [] } : run;
}

// An unknown id reaches here off a stored record or an IPC payload. Echo it, but
// bounded and stripped of anything that could be used to smuggle a string out.
function unknownConnector(id: unknown): string {
  const shown = typeof id === 'string' ? id.replace(/[^\w.-]/g, '').slice(0, 40) : '';
  return shown ? `Unknown connector: ${shown}` : 'Unknown connector';
}
