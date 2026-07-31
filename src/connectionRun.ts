// Connection runners — MAIN PROCESS ONLY.
// Two read-only data sources that each produce a ParseResult (identical shape to
// the CSV/JSON/xlsx file path), so a connection flows into the exact same
// Datasets → Visuals pipeline.
//
//   • Postgres (via the pure-JS `pg` driver — no native build): connect with a
//     timeout, list tables via a PARAMETERIZED information_schema query, run
//     either a chosen table (whitelist-validated + double-quoted identifier) or
//     a user's own query (run as-is but sub-select-wrapped with a row LIMIT and
//     a statement_timeout). The client is ALWAYS closed in a finally.
//   • URL / API JSON: fetch a user-typed https URL (browser-like), byte-capped
//     and timeout-bounded, then run the body through parse.ts's parseJson.
//
// This module holds NO secrets and touches NO Electron config — the IPC layer
// resolves the password / token and passes it in. No fs. Every function returns
// a discriminated {ok:true,...} | {ok:false,error} — an error string is
// sanitized and NEVER carries the password or a full DSN.

import { Client } from 'pg';
import { finalizeTable, parseJson, ParseResult } from './parse';

const ROW_LIMIT = 50_000; // reuse the file path's MAX_ROWS cap
const MAX_BYTES = 100 * 1024 * 1024; // reuse the 100MB byte ceiling for the URL source
const CONNECT_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;

export interface PgConnConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  ssl?: boolean;
}

type RunOk = { ok: true; result: ParseResult };
type RunErr = { ok: false; error: string };

// Replace any occurrence of the secret in a message with '***', then return a
// trimmed message. Belt-and-suspenders: pg error messages don't include the
// password, but this guarantees a secret can never ride out in an error string.
function sanitizeError(err: unknown, secret?: string): string {
  let msg = (err && (err as any).message) ? String((err as any).message) : 'Connection failed';
  if (secret && secret.length > 0) msg = msg.split(secret).join('***');
  return msg;
}

// A Postgres identifier we are willing to interpolate into SQL (identifiers can't
// be bound parameters). Plain leading letter/underscore, then letters/digits/_/$.
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

// Double-quote a validated identifier (defensive quote-doubling even though the
// whitelist regex forbids embedded quotes).
function quoteIdent(id: string): string {
  return '"' + id.replace(/"/g, '""') + '"';
}

// Build a fresh pg Client from the non-secret config + the resolved password.
function makeClient(cfg: PgConnConfig, password: string): Client {
  return new Client({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
}

// Stringify a pg cell value for finalizeTable (which type-detects over strings,
// exactly like the CSV/JSON path). null → '' (empty), Date → ISO, object → JSON.
function cellToString(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── Postgres ─────────────────────────────────────────────────────────────────

// List user tables via a PARAMETERIZED information_schema query (never a
// string-concatenated identifier). Client always closed in finally.
export async function pgListTables(
  cfg: PgConnConfig,
  password: string,
): Promise<{ ok: true; tables: { schema: string; name: string }[] } | RunErr> {
  const client = makeClient(cfg, password);
  try {
    await client.connect();
    const r = await client.query(
      `select table_schema, table_name from information_schema.tables
         where table_schema not in ('pg_catalog', 'information_schema')
         order by table_schema, table_name
         limit 1000`,
    );
    const tables = r.rows.map((row: any) => ({ schema: String(row.table_schema), name: String(row.table_name) }));
    return { ok: true, tables };
  } catch (err) {
    return { ok: false, error: sanitizeError(err, password) };
  } finally {
    await client.end().catch(() => {});
  }
}

// Run either a chosen table OR the user's own query, mapped to a ParseResult.
// It IS the user's own DB, so a user query runs as-is — but always sub-select
// wrapped with a LIMIT and bounded by statement_timeout. Client always closed.
export async function pgRun(
  cfg: PgConnConfig,
  password: string,
  tableOrQuery: { table?: string; query?: string },
): Promise<RunOk | RunErr> {
  let sql: string;
  const table = typeof tableOrQuery?.table === 'string' ? tableOrQuery.table.trim() : '';
  const query = typeof tableOrQuery?.query === 'string' ? tableOrQuery.query.trim() : '';

  if (table) {
    // schema.table or bare table — validate EVERY part against the whitelist
    // before quoting. Identifiers can't be bound params; regex + quoting is the
    // guard against injection.
    const parts = table.split('.');
    if (parts.length > 2 || parts.some((p) => !IDENT_RE.test(p))) {
      return { ok: false, error: 'Invalid table name' };
    }
    const quoted = parts.map(quoteIdent).join('.');
    sql = `select * from ${quoted} limit ${ROW_LIMIT}`;
  } else if (query) {
    // Their DB, their SQL. The sub-select wrapper just bounds rows; a trailing
    // semicolon would break the wrapper, so strip it.
    const inner = query.replace(/;\s*$/, '');
    sql = `select * from ( ${inner} ) as _sc_wrap limit ${ROW_LIMIT}`;
  } else {
    return { ok: false, error: 'No table or query specified' };
  }

  const client = makeClient(cfg, password);
  try {
    await client.connect();
    // rowMode:'array' → rows are arrays parallel to fields, so duplicate column
    // names (e.g. from a join select *) don't collide in an object.
    const res = await client.query({ text: sql, rowMode: 'array' } as any);
    const header = (res.fields || []).map((f: any) => String(f.name));
    const body: string[][] = (res.rows || []).map((row: any[]) => row.map(cellToString));
    return { ok: true, result: finalizeTable(header, body) };
  } catch (err) {
    return { ok: false, error: sanitizeError(err, password) };
  } finally {
    await client.end().catch(() => {});
  }
}

// ── URL / API JSON source ──────────────────────────────────────────────────────

// Fetch a user-typed https URL (browser-like), expect JSON, run it through
// parse.ts's parseJson. Bounded by a byte ceiling AND a timeout. Never leaks the
// token in an error.
export async function urlRun(url: string, authToken?: string): Promise<RunOk | RunErr> {
  // https-only — a user-typed URL, not an arbitrary scheme. Reject http/file/etc.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { ok: false, error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only https URLs are allowed' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (authToken) headers['authorization'] = `Bearer ${authToken}`;

    const resp = await fetch(parsed.toString(), { method: 'GET', headers, signal: controller.signal });
    if (!resp.ok) {
      return { ok: false, error: `Request failed (HTTP ${resp.status})` };
    }
    if (!resp.body) {
      return { ok: false, error: 'Empty response' };
    }

    // Stream + accumulate, aborting once we exceed the byte ceiling so a huge
    // (or unbounded) response can't OOM the main process.
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_BYTES) {
          try { await reader.cancel(); } catch (_) {}
          return { ok: false, error: 'Response too large' };
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');

    const result = parseJson(text);
    // parseJson never throws — a non-JSON / non-tabular body yields 0 columns and
    // a warning. Surface that as a friendly error rather than an empty dataset.
    if (!result.columns.length) {
      return { ok: false, error: 'Could not read JSON as a table' };
    }
    return { ok: true, result };
  } catch (err: any) {
    if (err && err.name === 'AbortError') {
      return { ok: false, error: `Request timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s` };
    }
    return { ok: false, error: sanitizeError(err, authToken) };
  } finally {
    clearTimeout(timer);
  }
}
