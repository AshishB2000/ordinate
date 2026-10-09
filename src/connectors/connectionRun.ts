// Connection dispatch — MAIN PROCESS ONLY.
//
// This used to BE the two data sources: a hardcoded pgListTables/pgRun/urlRun
// switch. It is now the layer that resolves a stored `connectorId` to its
// ConnectorDef (src/connectors), builds the one ConnectorContext that carries the
// bounds every connector must honour, and folds whatever comes back into the
// ParseResult the Datasets → Visuals pipeline already consumes. Adding a source
// does not touch this file.
//
// It holds NO secrets and touches NO config — the IPC layer resolves the
// password / token and passes it in. No fs. Every function returns a
// discriminated {ok:true,...} | {ok:false,error}, and EVERY error path goes
// through safeError(), so a driver string carrying a DSN or a password is
// redacted before it can reach a renderer.

import { coerceValue, finalizeTable, ParseResult } from '../data/parse';
import { getConnector } from './index';
import { estimateLabel, quotedTablePath } from './bigqueryShape';
import { safeError } from './types';
import { checkHost, guardOn } from './ssrf';
import type {
  ConnectorColumn,
  ConnectorColumnDetail,
  ConnectorContext,
  ConnectorDef,
} from './types';

// The bounds fed into every ConnectorContext. Unchanged from the pre-registry
// runner: the same 1M row cap as the file path (parse.ts MAX_ROWS) and the same
// 30s statement timeout Postgres has always run under. A connector MUST apply
// both — see contract rule 3 — which is why they are passed rather than assumed.
export const ROW_LIMIT = 1_000_000;
export const QUERY_TIMEOUT_MS = 30_000;

/** Default peek size for the workbench's table sample and query preview. Big
 *  enough to see the shape of the data, small enough that clicking around a
 *  schema tree never costs a warehouse scan. */
export const SAMPLE_ROWS = 500;

export interface RunBounds {
  rowLimit?: number;
  timeoutMs?: number;
}

type RunOk = { ok: true; result: ParseResult; truncated: boolean };
type RunErr = { ok: false; error: string };
type TablesOk = { ok: true; tables: { schema?: string; name: string }[]; warnings?: string[] };

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

/**
 * The SSRF guard for a typed host (T6.1), on the server only: the `host` field
 * is resolved and checked, and its address pinned into `ctx.pinned` for the DB
 * driver to connect to. Every source naming its server in a `host` field goes
 * through here; the URL source, the HTTP engines' transport, the SaaS transport
 * and Oracle's ADB connect string check their own hosts (ssrf.ts). A refusal
 * string, or null to go ahead.
 */
async function guardHost(def: ConnectorDef, ctx: ConnectorContext): Promise<string | null> {
  if (!guardOn() || !(def.fields || []).some((f) => f.key === 'host')) return null;
  try {
    ctx.pinned = await checkHost(String(ctx.values.host ?? ''));
    return null;
  } catch (err: unknown) {
    return safeError(err, ctx.secrets);
  }
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
// what Postgres, DuckDB, ClickHouse, Trino and Presto all accept — and Snowflake,
// whose listTables names `SCHEMA.TABLE`, or `DB.SCHEMA.TABLE` when the connection
// has no database (quoted part by part, so the stored case is matched exactly).
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
  const quoted = quotedTable(family, table);
  return quoted === null ? null : (DIALECTS[family] || ANSI).limit(`select * from ${quoted}`, rowLimit);
}

/** A validated table name quoted for this family, or null when it fails the
 *  whitelist. Exported for incremental refresh, which adds a WHERE to it. */
export function quotedTable(family: string, table: string): string | null {
  const name = String(table || '').trim();
  // BigQuery names a table `dataset.table` or `project.dataset.table`, and a
  // project id has dashes (a legacy domain-scoped one a dot and a colon), which
  // IDENT_RE refuses. Its own validator holds every part to a charset with no
  // backtick, backslash or newline, so the whole path is one backtick identifier.
  if (family === 'bigquery') return quotedTablePath(name);
  const parts = name.split('.');
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !IDENT_RE.test(p))) return null;
  const dialect = DIALECTS[family] || ANSI;
  // The duckdb family reports a COMPLETE identifier with any schema folded into
  // the name (see local.ts's CONTRACT NOTE): its tables live in a catalog
  // attached under a per-call random alias, so `"reporting"."t"` would bind
  // against the app's own in-memory catalog and find nothing. Quote the whole
  // name as one identifier instead. Splitting it was a silent wrong-catalog
  // lookup that only a non-`main` schema could reach.
  return family === 'duckdb' ? dialect.quote(name) : parts.map(dialect.quote).join('.');
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

// The source's own column TYPE NAMES are deliberately DISCARDED here: parse.ts's
// detector is what decides whether `007` is a number, and it must decide the same
// way for a database column as for a CSV column, or the same data would type
// differently depending on where it came from.
//
// The one exception is `columnType`, which a connector sets only when the
// source's own schema DECLARES the column (a SaaS API field documented as a
// number, a date or text). That is not a guess, so it wins: a text property
// holding "12345" stays text. Cells are re-coerced from their original strings,
// through the same coerceValue a retype uses, so nothing is lost on the way.
function toParseResult(
  columns: ConnectorColumn[],
  rows: (string | number | boolean | null)[][],
  truncated: boolean,
): ParseResult {
  const header = (columns || []).map((c) => String(c?.name ?? ''));
  const body = (rows || []).map((row) => (row || []).map(cellToString));
  const result = finalizeTable(header, body);
  (columns || []).forEach((c, i) => {
    const t = c?.columnType;
    if ((t !== 'text' && t !== 'number' && t !== 'date') || !result.columns[i] || result.columns[i].type === t) return;
    result.columns[i].type = t;
    result.rows.forEach((row, r) => { row[i] = coerceValue(body[r]?.[i] ?? '', t); });
  });
  if (truncated) {
    // The count actually kept — a connector may stop below the caller's row
    // limit (a SaaS source's page cap), and naming the limit would be wrong.
    result.warnings = result.warnings.concat(
      `Result truncated at ${result.rows.length.toLocaleString('en-US')} rows.`,
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
  const refused = await guardHost(def, ctx);
  if (refused) return { ok: false, error: refused };
  try {
    const res = await def.listTables(ctx);
    if (!res.ok) return { ok: false, error: safeError(res.error, ctx.secrets) };
    const tables = (res.tables || []).map((t) => ({
      schema: typeof t?.schema === 'string' ? t.schema : undefined,
      name: String(t?.name ?? ''),
    }));
    // A test's warnings travel beside the tables, redacted like an error would be.
    const warnings = (Array.isArray(res.warnings) ? res.warnings : []).filter((w) => typeof w === 'string' && w).map((w) => safeError(w, ctx.secrets));
    return warnings.length ? { ok: true, tables, warnings } : { ok: true, tables };
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
  const res = await fetchRows(connectorId, values, secrets, selection, bounds);
  if (!res.ok) return res;
  return { ok: true, result: toParseResult(res.columns, res.rows, res.truncated), truncated: res.truncated };
}

/**
 * `runConnection`, but the cells as the STRINGS the type detector would see,
 * untyped. For incremental refresh, which coerces a batch to the stored table's
 * types rather than re-detecting them from a handful of new rows.
 */
export async function runConnectionText(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  selection: { table?: string; query?: string },
  bounds?: RunBounds,
): Promise<{ ok: true; header: string[]; body: string[][]; truncated: boolean } | RunErr> {
  const res = await fetchRows(connectorId, values, secrets, selection, bounds);
  if (!res.ok) return res;
  return {
    ok: true,
    header: res.columns.map((c) => String(c?.name ?? '')),
    body: res.rows.map((row) => (row || []).map(cellToString)),
    truncated: res.truncated,
  };
}

async function fetchRows(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  selection: { table?: string; query?: string },
  bounds?: RunBounds,
): Promise<{ ok: true; columns: ConnectorColumn[]; rows: (string | number | boolean | null)[][]; truncated: boolean } | RunErr> {
  const def = resolve(connectorId);
  if (!def) return { ok: false, error: unknownConnector(connectorId) };
  const ctx = buildContext(values, secrets, bounds);

  const sql = selectionSql(def, selection || {}, ctx.rowLimit);
  if (!sql.ok) return sql;
  const refused = await guardHost(def, ctx);
  if (refused) return { ok: false, error: refused };

  try {
    const res = await def.run(ctx, sql.sql);
    if (!res.ok) return { ok: false, error: safeError(res.error, ctx.secrets) };
    const truncated = res.truncated === true || (res.rows || []).length > ctx.rowLimit;
    const rows = (res.rows || []).slice(0, ctx.rowLimit); // trust, then verify
    return { ok: true, columns: res.columns || [], rows, truncated };
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
): Promise<TablesOk | RunErr> {
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

/**
 * One table's columns, out of the SOURCE'S OWN CATALOG.
 *
 * Returns `null` — not an error — when this connector has no `describeTable`.
 * That is the signal the workbench reads to hide the schema browser entirely:
 * an HTTP engine or the URL source can still list and run, it just has no
 * uniform catalog to ask, and a tree of tables you cannot open is worse than no
 * tree. A real failure (bad credentials, no such table) is still `{ok:false}`.
 */
export async function describeTable(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  table: string,
  bounds?: RunBounds,
): Promise<{ ok: true; columns: ConnectorColumnDetail[]; rowEstimate?: number } | RunErr | null> {
  const def = resolve(connectorId);
  if (!def) return { ok: false, error: unknownConnector(connectorId) };
  if (typeof def.describeTable !== 'function') return null;
  const ctx = buildContext(values, secrets, bounds);
  const refused = await guardHost(def, ctx);
  if (refused) return { ok: false, error: refused };
  try {
    const res = await def.describeTable(ctx, String(table ?? ''));
    if (!res.ok) return { ok: false, error: safeError(res.error, ctx.secrets) };
    const columns = (res.columns || [])
      .map((c) => {
        const out: ConnectorColumnDetail = { name: String(c?.name ?? ''), type: String(c?.type ?? '') };
        if (typeof c?.nullable === 'boolean') out.nullable = c.nullable;
        return out;
      })
      .filter((c) => c.name);
    const n = Number(res.rowEstimate);
    return Number.isFinite(n) && n >= 0
      ? { ok: true, columns, rowEstimate: Math.round(n) }
      : { ok: true, columns };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

/**
 * A bounded peek at one table.
 *
 * Deliberately NOT a sixth per-driver method. A sample is `select * from <t>
 * limit n`, and compiling a table name into exactly that — with the right
 * quoting, the right row-limit syntax, and the whitelist that makes an
 * interpolated identifier safe — is what `buildTableSql` already does for five
 * dialects, on the path every saved table import already takes. A per-driver
 * copy would be five new ways to emit an unbounded query for no behaviour the
 * dispatch does not already have.
 *
 * `limit` may only lower the bound: buildContext clamps to ROW_LIMIT, so no
 * caller can widen it.
 */
export async function sampleTable(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  table: string,
  limit: number,
  bounds?: RunBounds,
): Promise<RunOk | RunErr> {
  const rowLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SAMPLE_ROWS;
  return runConnection(connectorId, values, secrets, { table: String(table ?? '') }, {
    ...bounds,
    rowLimit: Math.min(rowLimit, bounds?.rowLimit ?? ROW_LIMIT),
  });
}

/**
 * Validate a statement and report the columns it would produce, WITHOUT
 * fetching a result.
 *
 * Implemented as the `LIMIT 0`-style dry run rather than `EXPLAIN`, for two
 * reasons that both point the same way: `EXPLAIN` output is a different shape
 * on every one of these engines (and is not available at all on several), and —
 * the reason that actually decides it — a plan does not carry the OUTPUT COLUMN
 * NAMES, which is the whole thing the caller asked for. Running the user's own
 * statement bounded to a single row costs one round trip, answers with the real
 * columns and the real source types, and surfaces a syntax error as the
 * dialect's own message. The row itself is discarded here and never leaves main.
 */
export async function explainSql(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  sql: string,
): Promise<{ ok: true; columns: ConnectorColumn[] } | RunErr> {
  const def = resolve(connectorId);
  if (!def) return { ok: false, error: unknownConnector(connectorId) };
  const statement = typeof sql === 'string' ? sql.trim() : '';
  if (!statement) return { ok: false, error: 'No query to check' };
  const ctx = buildContext(values, secrets, { rowLimit: 1 });
  const refused = await guardHost(def, ctx);
  if (refused) return { ok: false, error: refused };
  try {
    const res = await def.run(ctx, statement.replace(/;\s*$/, ''));
    if (!res.ok) return { ok: false, error: safeError(res.error, ctx.secrets) };
    return {
      ok: true,
      columns: (res.columns || []).map((c) => ({
        name: String(c?.name ?? ''),
        type: String(c?.type ?? ''),
      })),
    };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

/**
 * What a statement would read, priced BEFORE it runs: the connector's free dry
 * run (`live.estimate`, BigQuery's totalBytesProcessed), with the editor's
 * "~1.2 GB" label formatted here, server side. `null` — not an error — when the
 * connector cannot estimate; the catalog's `estimates` flag says so up front.
 */
export async function estimateSql(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  sql: string,
): Promise<{ ok: true; bytes: number; label: string } | RunErr | null> {
  const def = resolve(connectorId);
  if (!def) return { ok: false, error: unknownConnector(connectorId) };
  if (typeof def.live?.estimate !== 'function') return null;
  const statement = typeof sql === 'string' ? sql.trim().replace(/;\s*$/, '') : '';
  if (!statement) return { ok: false, error: 'No query to estimate' };
  const ctx = buildContext(values, secrets, { rowLimit: 1 });
  const refused = await guardHost(def, ctx);
  if (refused) return { ok: false, error: refused };
  try {
    const res = await def.live.estimate(ctx, statement, []);
    if (!res.ok) return { ok: false, error: safeError(res.error, ctx.secrets) };
    return { ok: true, bytes: res.bytes, label: estimateLabel(res.bytes) };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}

// An unknown id reaches here off a stored record or an IPC payload. Echo it, but
// bounded and stripped of anything that could be used to smuggle a string out.
function unknownConnector(id: unknown): string {
  const shown = typeof id === 'string' ? id.replace(/[^\w.-]/g, '').slice(0, 40) : '';
  return shown ? `Unknown connector: ${shown}` : 'Unknown connector';
}
