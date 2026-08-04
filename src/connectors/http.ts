// HTTP query-engine connectors — MAIN PROCESS ONLY.
//
// Seven engines that all speak HTTP + JSON, so they share one transport and
// differ only in request/response shaping:
//
//   clickhouse     POST /            SQL in the body, FORMAT JSONCompact
//   databricks-sql POST /api/2.0/sql/statements       Bearer token + warehouse id
//   trino          POST /v1/statement                 paged via nextUri
//   presto         POST /v1/statement                 same protocol, X-Presto-* headers
//   elasticsearch  POST /_sql?format=json
//   opensearch     POST /_plugins/_sql?format=jdbc
//   druid          POST /druid/v2/sql
//
// ZERO new dependencies: Node's own `http`/`https`. This family is the one that
// can be tested for real without a live server (scripts/test-connectorsHttp.ts
// drives it against a local http.createServer stub), which is exactly why it is
// worth keeping dependency-free.
//
// Three caps on EVERY request, all actually enforced (see httpRequest):
//   • ctx.timeoutMs — wall clock, and the socket is DESTROYED. A bare
//     setTimeout that does not req.destroy() leaves the connection (and the
//     server-side query) running; that is not a timeout, that is a wish.
//   • MAX_BYTES    — the response is clipped and the socket destroyed. Same
//     100MB ceiling connectionRun.ts already uses for the URL source. An
//     unbounded response from a warehouse is how a local-first app eats
//     someone's memory.
//   • ctx.rowLimit — rows are capped, and `truncated: true` is reported. Never
//     trimmed silently.
//
// READ-ONLY (rule 1 in types.ts) — what is actually enforced, per engine:
//   • clickhouse    ENFORCED: the `readonly=2` URL setting. 2 (not 1) because 1
//                   also forbids changing any other setting in the same
//                   request, which would reject our own row/time caps.
//   • elasticsearch ENFORCED BY THE ENGINE: the _sql endpoint's grammar has no
//                   INSERT/UPDATE/DELETE/DDL at all — SELECT/SHOW/DESCRIBE only.
//   • opensearch    ENFORCED BY THE ENGINE: same, the SQL plugin is query-only.
//   • druid         ENFORCED BY THE ENDPOINT: /druid/v2/sql is query-only.
//                   Ingestion lives behind /druid/v2/sql/task (MSQ) and the
//                   indexing service, which this connector never calls.
//   • trino         NOT ENFORCED. Trino has no read-only session property; the
//                   only real guard is a read-only user on the cluster.
//   • presto        NOT ENFORCED. Same as Trino.
//   • databricks-sql NOT ENFORCED. The SQL Statement Execution API has no
//                   read-only flag; the guard is the token's own grants.
//   Where it says NOT ENFORCED, this file implements no guard and claims none.
//   `readOnly: true` on the def means "this app has no write path", per types.ts
//   — it is documentation of intent, not a server-side restriction.
//
// TLS: https is the default everywhere. Plain HTTP is an explicit per-connection
// opt-in field (`insecureHttp`) on the six self-hostable engines, with help text
// saying credentials cross the network in clear. Databricks is a hosted service
// and has no opt-in at all. Certificate verification is never disabled.
//
// Nothing here logs a request body or an Authorization header, and every error
// goes out through safeError(e, ctx.secrets) — these engines echo the submitted
// query, and sometimes the auth header, straight back in their error bodies.

import * as http from 'http';
import * as https from 'https';
import {
  ConnectorColumn,
  ConnectorContext,
  ConnectorDef,
  ConnectorError,
  ConnectorField,
  ConnectorRows,
  ConnectorTable,
  ConnectorTables,
  safeError,
} from './types';

/** Response byte ceiling — the same constant connectionRun.ts's urlRun uses. */
export const MAX_BYTES = 100 * 1024 * 1024;

type Cell = string | number | boolean | null;

// ── transport ────────────────────────────────────────────────────────────────

export interface HttpRequestOptions {
  url: URL;
  method: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  /** Wall clock for this single request. The socket is destroyed on expiry. */
  timeoutMs: number;
  /** Byte ceiling for the response body. Defaults to MAX_BYTES. */
  maxBytes?: number;
}

export interface HttpResult {
  status: number;
  body: string;
  /** True when the byte ceiling clipped the body. */
  truncated: boolean;
}

/** One bounded HTTP request. Exported so the self-check can drive the transport
 *  directly against a stub server (byte cap, timeout, socket destruction). */
export function httpRequest(opts: HttpRequestOptions): Promise<HttpResult> {
  const maxBytes = opts.maxBytes === undefined ? MAX_BYTES : opts.maxBytes;
  return new Promise<HttpResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const done = (err: Error | null, value?: HttpResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(timedOut ? timeoutError(opts.timeoutMs) : err);
      else resolve(value as HttpResult);
    };

    let req: http.ClientRequest;
    try {
      const mod = opts.url.protocol === 'https:' ? https : http;
      req = mod.request(opts.url, {
        method: opts.method,
        headers: { 'user-agent': 'Ordinate', ...(opts.headers || {}) },
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    // The wall clock. destroy() is the whole point — it tears the socket down,
    // which is what stops the request instead of merely giving up on it.
    timer = setTimeout(() => {
      timedOut = true;
      req.destroy(timeoutError(opts.timeoutMs));
    }, opts.timeoutMs);

    req.on('error', (e: Error) => done(e));

    req.on('response', (res: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        if (settled) return;
        total += c.length;
        if (total > maxBytes) {
          // Keep the bytes up to the ceiling, then kill the socket so the
          // server stops sending. The body is deliberately a partial document.
          const keep = c.length - (total - maxBytes);
          if (keep > 0) chunks.push(c.subarray(0, keep));
          const out: HttpResult = {
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated: true,
          };
          res.destroy();
          req.destroy();
          done(null, out);
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        done(null, {
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
          truncated: false,
        });
      });
      res.on('error', (e: Error) => done(e));
    });

    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function timeoutError(ms: number): Error {
  return new Error(`Request timed out after ${Math.max(1, Math.round(ms / 1000))}s`);
}

// A parsed JSON response. `json` is undefined only when the byte cap clipped the
// body mid-document — the caller then reports truncation instead of guessing.
type JsonResult = { ok: true; json: unknown; clipped: boolean } | ConnectorError;

async function requestJson(
  ctx: ConnectorContext,
  opts: HttpRequestOptions,
): Promise<JsonResult> {
  let res: HttpResult;
  try {
    res = await httpRequest(opts);
  } catch (e) {
    return { ok: false, error: safeError(e, ctx.secrets) };
  }

  if (res.status < 200 || res.status >= 300) {
    // Engines put the failure detail in the body — and echo the query, and
    // occasionally the auth header. safeError strips every known secret first.
    const detail = res.body.trim().slice(0, 400);
    const msg = detail ? `HTTP ${res.status}: ${detail}` : `Request failed (HTTP ${res.status})`;
    return { ok: false, error: safeError(new Error(msg), ctx.secrets) };
  }

  let json: unknown;
  try {
    json = JSON.parse(res.body) as unknown;
  } catch (e) {
    if (res.truncated) return { ok: true, json: undefined, clipped: true };
    return { ok: false, error: safeError(new Error('Response was not valid JSON'), ctx.secrets) };
  }
  return { ok: true, json, clipped: res.truncated };
}

// ── small typed accessors (no `any`) ─────────────────────────────────────────

function prop(o: unknown, key: string): unknown {
  if (o !== null && typeof o === 'object') return (o as Record<string, unknown>)[key];
  return undefined;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v as Cell;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
function str(ctx: ConnectorContext, key: string, fallback = ''): string {
  const v = ctx.values[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}
function num(ctx: ConnectorContext, key: string, fallback: number): number {
  const v = ctx.values[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function bool(ctx: ConnectorContext, key: string): boolean {
  const v = ctx.values[key];
  return v === true || v === 'true' || v === 1 || v === '1';
}
function secret(ctx: ConnectorContext, key: string): string {
  const v = ctx.secrets[key];
  return typeof v === 'string' ? v : '';
}
/** Row cap: always at least 1, always finite. */
function rowCap(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.rowLimit);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
/** Wall clock for one operation: always at least 1s, always finite. */
function budgetMs(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.timeoutMs);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}
/** Trailing `;` breaks Trino/Presto/Druid/ES/OpenSearch. Strip it everywhere. */
function cleanSql(sql: string): string {
  return String(sql || '').trim().replace(/;\s*$/, '');
}
function basicAuth(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
}
function isErr(v: { ok: boolean }): v is ConnectorError {
  return v.ok === false;
}

// ── host / URL construction ──────────────────────────────────────────────────

/** The plain-HTTP opt-in. Off by default; https is the default everywhere. */
const INSECURE_FIELD: ConnectorField = {
  key: 'insecureHttp',
  label: 'Use plain HTTP (no TLS)',
  type: 'checkbox',
  default: false,
  help:
    'Off by default. When on, the query, your results and your credentials cross ' +
    'the network in clear text — only tick this for a host on this machine or a ' +
    'trusted private network.',
};

function hostField(help?: string): ConnectorField {
  return { key: 'host', label: 'Host', type: 'text', required: true, placeholder: 'warehouse.internal', help };
}
function portField(def: number, help: string): ConnectorField {
  return { key: 'port', label: 'Port', type: 'number', default: def, help };
}

/** Build the origin URL from the form values.
 *  https unless `insecureHttp` is explicitly ticked; a pasted `http://` host is
 *  REJECTED rather than silently honoured, so TLS can never be lost by accident. */
function buildBase(
  ctx: ConnectorContext,
  defaultPort: number,
  httpsOnly = false,
): URL | ConnectorError {
  let host = str(ctx, 'host').trim();
  if (!host) return { ok: false, error: 'Host is required' };

  let pastedInsecure = false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//.exec(host);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === 'http') pastedInsecure = true;
    else if (s !== 'https') return { ok: false, error: 'Host must be a hostname or an http/https URL' };
    host = host.slice(scheme[0].length);
  }
  host = host.replace(/[/?#].*$/, '');

  let portFromHost = 0;
  const pm = /:(\d+)$/.exec(host);
  if (pm) {
    portFromHost = Number(pm[1]);
    host = host.slice(0, pm.index);
  }
  if (!host) return { ok: false, error: 'Host is required' };

  const optIn = !httpsOnly && bool(ctx, 'insecureHttp');
  if (pastedInsecure && httpsOnly) {
    return { ok: false, error: 'This source is https-only' };
  }
  if (pastedInsecure && !optIn) {
    return {
      ok: false,
      error: 'Plain HTTP is off. Tick "Use plain HTTP (no TLS)" to allow an unencrypted connection.',
    };
  }

  const proto = optIn ? 'http:' : 'https:';
  const port = num(ctx, 'port', 0) || portFromHost || defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: 'Port must be between 1 and 65535' };
  }
  try {
    return new URL(`${proto}//${host}:${port}/`);
  } catch {
    return { ok: false, error: 'Invalid host' };
  }
}

/** Re-anchor a server-supplied URI (Trino's `nextUri`) onto the base origin.
 *  The path/query are the server's, but the scheme and host stay OURS: a
 *  coordinator behind a proxy hands back an internal hostname, and honouring an
 *  arbitrary host from a response body would be an SSRF and a silent TLS
 *  downgrade in one. */
function rebase(uri: string, base: URL): URL | null {
  try {
    const u = new URL(uri, base);
    return new URL(u.pathname + u.search, base);
  } catch {
    return null;
  }
}

// ── table listing ────────────────────────────────────────────────────────────

const NAME_KEYS = ['table_name', 'tablename', 'name', 'table'];
const SCHEMA_KEYS = ['table_schema', 'table_schem', 'schema', 'database', 'db', 'table_cat', 'catalog'];

/** Map a result set onto ConnectorTable[]. Prefer well-known column NAMES
 *  (OpenSearch's SHOW TABLES puts the catalog first, so positional guessing
 *  would report the catalog as the schema), fall back to position. */
function tablesFromRows(r: ConnectorRows): ConnectorTables {
  const lower = r.columns.map((c) => c.name.toLowerCase());
  let nameIdx = lower.findIndex((n) => NAME_KEYS.includes(n));
  let schemaIdx = lower.findIndex((n) => SCHEMA_KEYS.includes(n));
  if (nameIdx < 0) {
    nameIdx = r.columns.length >= 2 ? 1 : 0;
    schemaIdx = r.columns.length >= 2 ? 0 : -1;
  }
  const tables: ConnectorTable[] = [];
  for (const row of r.rows) {
    const name = row[nameIdx] == null ? '' : String(row[nameIdx]);
    if (!name) continue;
    const schema = schemaIdx >= 0 && row[schemaIdx] != null ? String(row[schemaIdx]) : '';
    tables.push(schema ? { schema, name } : { name });
  }
  return { ok: true, tables };
}

/** Cap rows and report it. The one place rowLimit is applied client-side. */
function capRows(columns: ConnectorColumn[], rows: Cell[][], ctx: ConnectorContext, already = false): ConnectorRows {
  const cap = rowCap(ctx);
  const truncated = already || rows.length > cap;
  return { ok: true, columns, rows: rows.length > cap ? rows.slice(0, cap) : rows, truncated };
}

const CLIPPED = 'Response exceeded the 100 MB ceiling and was cut off — narrow the query or lower the row limit.';

// ── ClickHouse ───────────────────────────────────────────────────────────────

// POST the SQL as the request body; settings ride in the query string.
// readonly=2 (see the header comment) is the read-only guard.
async function clickhouseRun(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const base = buildBase(ctx, 8443);
  if (isErr(base as { ok: boolean })) return base as ConnectorError;
  const url = base as URL;

  const cap = rowCap(ctx);
  const ms = budgetMs(ctx);
  url.searchParams.set('database', str(ctx, 'database', 'default') || 'default');
  url.searchParams.set('default_format', 'JSONCompact');
  url.searchParams.set('readonly', '2');
  // +1 so an exactly-at-the-cap result is distinguishable from a clipped one.
  url.searchParams.set('max_result_rows', String(cap + 1));
  url.searchParams.set('result_overflow_mode', 'break');
  url.searchParams.set('max_execution_time', String(Math.max(1, Math.round(ms / 1000))));

  let body = cleanSql(sql);
  if (!body) return { ok: false, error: 'No query specified' };
  // Only append the format when the user has not written their own FORMAT
  // clause — two FORMAT clauses is a syntax error.
  if (!/\bFORMAT\s+[A-Za-z0-9_]+\s*$/i.test(body)) body += ' FORMAT JSONCompact';

  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
  const user = str(ctx, 'user', 'default') || 'default';
  headers['x-clickhouse-user'] = user;
  const pw = secret(ctx, 'password');
  if (pw) headers['x-clickhouse-key'] = pw;

  const r = await requestJson(ctx, { url, method: 'POST', headers, body, timeoutMs: ms });
  if (isErr(r)) return r;
  if (r.json === undefined) return { ok: false, error: CLIPPED };

  const meta = asArray(prop(r.json, 'meta'));
  const columns: ConnectorColumn[] = meta.map((m) => ({
    name: asString(prop(m, 'name')),
    type: asString(prop(m, 'type')) || 'unknown',
  }));
  const rows: Cell[][] = asArray(prop(r.json, 'data')).map((row) => asArray(row).map(toCell));
  return capRows(columns, rows, ctx, r.clipped);
}

async function clickhouseListTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const r = await clickhouseRun(
    ctx,
    `SELECT database AS table_schema, name AS table_name FROM system.tables
       WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
       ORDER BY database, name LIMIT 1000`,
  );
  return isErr(r) ? r : tablesFromRows(r);
}

// ── Databricks SQL ───────────────────────────────────────────────────────────

// /api/2.0/sql/statements, Bearer token, warehouse id. wait_timeout parks the
// request server-side; on_wait_timeout: CANCEL means a statement we stop waiting
// for is CANCELLED rather than left running on the warehouse (= billing).
// There is NO read-only flag on this API — see the header comment.
async function databricksRun(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const base = buildBase(ctx, 443, true);
  if (isErr(base as { ok: boolean })) return base as ConnectorError;
  const url = base as URL;
  url.pathname = '/api/2.0/sql/statements';

  const warehouse = str(ctx, 'warehouseId').trim();
  if (!warehouse) return { ok: false, error: 'Warehouse ID is required' };
  const token = secret(ctx, 'token');
  if (!token) return { ok: false, error: 'Personal access token is required' };
  const statement = cleanSql(sql);
  if (!statement) return { ok: false, error: 'No query specified' };

  const ms = budgetMs(ctx);
  const cap = rowCap(ctx);
  // The API only accepts 5s–50s (or "0s"); clamp rather than get a 400.
  const wait = Math.min(50, Math.max(5, Math.round(ms / 1000)));

  const payload: Record<string, unknown> = {
    statement,
    warehouse_id: warehouse,
    wait_timeout: `${wait}s`,
    on_wait_timeout: 'CANCEL',
    format: 'JSON_ARRAY',
    disposition: 'INLINE',
    row_limit: cap,
  };
  const catalog = str(ctx, 'catalog').trim();
  const schema = str(ctx, 'schema').trim();
  if (catalog) payload.catalog = catalog;
  if (schema) payload.schema = schema;

  const r = await requestJson(ctx, {
    url,
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: ms,
  });
  if (isErr(r)) return r;
  if (r.json === undefined) return { ok: false, error: CLIPPED };
  return shapeDatabricks(r.json, ctx, r.clipped);
}

/** Databricks response → ConnectorRows. Split out and exported because this is
 *  the ONE engine here that is https-only (it is a hosted service), so the
 *  self-check cannot reach it through a plain-HTTP stub server — this shaping is
 *  unit-tested directly instead. */
export function shapeDatabricks(
  json: unknown,
  ctx: ConnectorContext,
  clipped = false,
): ConnectorRows | ConnectorError {
  const status = prop(json, 'status');
  const state = asString(prop(status, 'state'));
  if (state && state !== 'SUCCEEDED') {
    const detail = asString(prop(prop(status, 'error'), 'message')) || state;
    return { ok: false, error: safeError(new Error(`Statement ${state}: ${detail}`), ctx.secrets) };
  }

  const manifest = prop(json, 'manifest');
  const columns: ConnectorColumn[] = asArray(prop(prop(manifest, 'schema'), 'columns')).map((c) => ({
    name: asString(prop(c, 'name')),
    type: asString(prop(c, 'type_text')) || asString(prop(c, 'type_name')) || 'unknown',
  }));
  const rows: Cell[][] = asArray(prop(prop(json, 'result'), 'data_array')).map((row) =>
    asArray(row).map(toCell),
  );
  const serverTruncated = prop(manifest, 'truncated') === true;
  return capRows(columns, rows, ctx, clipped || serverTruncated);
}

async function databricksListTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const r = await databricksRun(
    ctx,
    `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_schema <> 'information_schema' ORDER BY table_schema, table_name LIMIT 1000`,
  );
  return isErr(r) ? r : tablesFromRows(r);
}

// ── Trino / Presto ───────────────────────────────────────────────────────────

// The trap in this family. A POST to /v1/statement returns a `nextUri` and very
// often ZERO rows; results dribble in across many follow-ups. So:
//   • follow nextUri until it is ABSENT (that, not an empty page, is the end),
//   • stop early once rowLimit or the byte budget is hit,
//   • and when we stop early, DELETE the nextUri. Abandoning it leaves the query
//     RUNNING on the cluster, burning cluster time nobody is reading.
// Trino and Presto are the same protocol with a different header prefix.
interface TrinoFlavor {
  prefix: 'X-Trino' | 'X-Presto';
  defaultPort: number;
}

async function trinoQuery(
  ctx: ConnectorContext,
  sql: string,
  flavor: TrinoFlavor,
): Promise<ConnectorRows | ConnectorError> {
  const base = buildBase(ctx, flavor.defaultPort);
  if (isErr(base as { ok: boolean })) return base as ConnectorError;
  const origin = base as URL;

  const statement = cleanSql(sql);
  if (!statement) return { ok: false, error: 'No query specified' };
  const user = str(ctx, 'user').trim();
  if (!user) return { ok: false, error: 'User is required' };

  const p = flavor.prefix.toLowerCase();
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    [`${p}-user`]: user,
    [`${p}-source`]: 'ordinate',
  };
  const catalog = str(ctx, 'catalog').trim();
  const schema = str(ctx, 'schema').trim();
  if (catalog) headers[`${p}-catalog`] = catalog;
  if (schema) headers[`${p}-schema`] = schema;
  const pw = secret(ctx, 'password');
  if (pw) headers.authorization = basicAuth(user, pw);

  const cap = rowCap(ctx);
  const deadline = Date.now() + budgetMs(ctx);
  let byteBudget = MAX_BYTES;

  let columns: ConnectorColumn[] = [];
  const rows: Cell[][] = [];
  let truncated = false;

  const start = new URL('/v1/statement', origin);
  let next: URL | null = start;
  let method: 'POST' | 'GET' = 'POST';
  let body: string | undefined = statement;

  // Cancel a still-live query. Best effort and deliberately silent: we are
  // already returning a result or an error, and a failed cancel must not
  // replace it. Never logs the URI (it carries the query id, not a secret, but
  // there is nothing to gain by printing it).
  const cancel = async (uri: URL): Promise<void> => {
    try {
      await httpRequest({ url: uri, method: 'DELETE', headers, timeoutMs: 5_000, maxBytes: 64 * 1024 });
    } catch {
      /* nothing useful to do — the result is already decided */
    }
  };

  while (next) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      await cancel(next);
      return { ok: false, error: timeoutError(budgetMs(ctx)).message };
    }

    const current: URL = next;
    let page: HttpResult;
    try {
      page = await httpRequest({
        url: current,
        method,
        headers,
        body,
        timeoutMs: remaining,
        maxBytes: Math.max(1, byteBudget),
      });
    } catch (e) {
      await cancel(current);
      return { ok: false, error: safeError(e, ctx.secrets) };
    }
    byteBudget -= Buffer.byteLength(page.body, 'utf8');

    if (page.status < 200 || page.status >= 300) {
      const detail = page.body.trim().slice(0, 400);
      return {
        ok: false,
        error: safeError(new Error(detail ? `HTTP ${page.status}: ${detail}` : `Request failed (HTTP ${page.status})`), ctx.secrets),
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(page.body) as unknown;
    } catch {
      // A page clipped by the byte ceiling is unparseable — stop, cancel, and
      // report what we already collected as truncated rather than pretending.
      if (page.truncated) {
        await cancel(current);
        return { ok: true, columns, rows: rows.slice(0, cap), truncated: true };
      }
      return { ok: false, error: safeError(new Error('Response was not valid JSON'), ctx.secrets) };
    }

    const err = prop(json, 'error');
    if (err) {
      const detail = asString(prop(err, 'message')) || 'Query failed';
      return { ok: false, error: safeError(new Error(detail), ctx.secrets) };
    }

    const cols = asArray(prop(json, 'columns'));
    if (cols.length && !columns.length) {
      columns = cols.map((c) => ({
        name: asString(prop(c, 'name')),
        type: asString(prop(c, 'type')) || 'unknown',
      }));
    }
    for (const row of asArray(prop(json, 'data'))) {
      rows.push(asArray(row).map(toCell));
    }

    const nextRaw = asString(prop(json, 'nextUri'));
    const nextUrl = nextRaw ? rebase(nextRaw, origin) : null;

    // Early stop: a cap was hit but the query is still live. Cancel it.
    if (nextUrl && (rows.length >= cap || byteBudget <= 0 || page.truncated)) {
      await cancel(nextUrl);
      truncated = true;
      next = null;
      break;
    }

    // ABSENT nextUri — not an empty page — is the only end of the loop.
    next = nextUrl;
    method = 'GET';
    body = undefined;
  }

  return capRows(columns, rows, ctx, truncated);
}

async function trinoListTables(ctx: ConnectorContext, flavor: TrinoFlavor): Promise<ConnectorTables | ConnectorError> {
  const r = await trinoQuery(
    ctx,
    `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_schema <> 'information_schema' ORDER BY table_schema, table_name LIMIT 1000`,
    flavor,
  );
  return isErr(r) ? r : tablesFromRows(r);
}

// ── Elasticsearch SQL ────────────────────────────────────────────────────────

// POST /_sql?format=json. Read-only by grammar: the endpoint has no DML/DDL.
// A `cursor` in the reply means more rows exist — we report truncation and
// CLOSE the cursor rather than leaving server state behind.
async function esRun(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const base = buildBase(ctx, 9200);
  if (isErr(base as { ok: boolean })) return base as ConnectorError;
  const origin = base as URL;

  const query = cleanSql(sql);
  if (!query) return { ok: false, error: 'No query specified' };
  const ms = budgetMs(ctx);
  const cap = rowCap(ctx);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = secret(ctx, 'apiKey');
  const pw = secret(ctx, 'password');
  const user = str(ctx, 'user').trim();
  if (apiKey) headers.authorization = `ApiKey ${apiKey}`;
  else if (user) headers.authorization = basicAuth(user, pw);

  const url = new URL('/_sql', origin);
  url.searchParams.set('format', 'json');

  const r = await requestJson(ctx, {
    url,
    method: 'POST',
    headers,
    // fetch_size is ES's own row cap; ours still applies on top.
    body: JSON.stringify({ query, fetch_size: cap, request_timeout: `${Math.max(1, Math.round(ms / 1000))}s` }),
    timeoutMs: ms,
  });
  if (isErr(r)) return r;
  if (r.json === undefined) return { ok: false, error: CLIPPED };

  const columns: ConnectorColumn[] = asArray(prop(r.json, 'columns')).map((c) => ({
    name: asString(prop(c, 'name')),
    type: asString(prop(c, 'type')) || 'unknown',
  }));
  const rows: Cell[][] = asArray(prop(r.json, 'rows')).map((row) => asArray(row).map(toCell));

  const cursor = asString(prop(r.json, 'cursor'));
  if (cursor) {
    try {
      await httpRequest({
        url: new URL('/_sql/close', origin),
        method: 'POST',
        headers,
        body: JSON.stringify({ cursor }),
        timeoutMs: 5_000,
        maxBytes: 64 * 1024,
      });
    } catch {
      /* best effort — the result is already decided */
    }
  }
  return capRows(columns, rows, ctx, r.clipped || Boolean(cursor));
}

async function esListTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const r = await esRun(ctx, 'SHOW TABLES');
  return isErr(r) ? r : tablesFromRows(r);
}

// ── OpenSearch SQL ───────────────────────────────────────────────────────────

// POST /_plugins/_sql (jdbc format → {schema, datarows}). Read-only by grammar,
// same as Elasticsearch: the SQL plugin only speaks SELECT/SHOW/DESCRIBE.
async function osRun(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const base = buildBase(ctx, 9200);
  if (isErr(base as { ok: boolean })) return base as ConnectorError;
  const origin = base as URL;

  const query = cleanSql(sql);
  if (!query) return { ok: false, error: 'No query specified' };
  const ms = budgetMs(ctx);
  const cap = rowCap(ctx);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const user = str(ctx, 'user').trim();
  const pw = secret(ctx, 'password');
  if (user) headers.authorization = basicAuth(user, pw);

  const url = new URL('/_plugins/_sql', origin);
  url.searchParams.set('format', 'jdbc');

  const r = await requestJson(ctx, {
    url,
    method: 'POST',
    headers,
    body: JSON.stringify({ query, fetch_size: cap }),
    timeoutMs: ms,
  });
  if (isErr(r)) return r;
  if (r.json === undefined) return { ok: false, error: CLIPPED };

  const columns: ConnectorColumn[] = asArray(prop(r.json, 'schema')).map((c) => ({
    name: asString(prop(c, 'alias')) || asString(prop(c, 'name')),
    type: asString(prop(c, 'type')) || 'unknown',
  }));
  const rows: Cell[][] = asArray(prop(r.json, 'datarows')).map((row) => asArray(row).map(toCell));

  const cursor = asString(prop(r.json, 'cursor'));
  if (cursor) {
    try {
      await httpRequest({
        url: new URL('/_plugins/_sql/close', origin),
        method: 'POST',
        headers,
        body: JSON.stringify({ cursor }),
        timeoutMs: 5_000,
        maxBytes: 64 * 1024,
      });
    } catch {
      /* best effort */
    }
  }
  return capRows(columns, rows, ctx, r.clipped || Boolean(cursor));
}

async function osListTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const r = await osRun(ctx, 'SHOW TABLES LIKE %');
  return isErr(r) ? r : tablesFromRows(r);
}

// ── Apache Druid ─────────────────────────────────────────────────────────────

// POST /druid/v2/sql with resultFormat "array" + header + typesHeader, so row 0
// is the column names and row 1 the types. Read-only by ENDPOINT: /druid/v2/sql
// is query-only; INSERT/REPLACE go through /druid/v2/sql/task, which we never
// call. We mint our own sqlQueryId so a timeout can DELETE the running query.
async function druidRun(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const base = buildBase(ctx, 8888);
  if (isErr(base as { ok: boolean })) return base as ConnectorError;
  const origin = base as URL;

  const query = cleanSql(sql);
  if (!query) return { ok: false, error: 'No query specified' };
  const ms = budgetMs(ctx);

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const user = str(ctx, 'user').trim();
  const pw = secret(ctx, 'password');
  if (user) headers.authorization = basicAuth(user, pw);

  const queryId = `ordinate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const url = new URL('/druid/v2/sql', origin);

  let res: HttpResult;
  try {
    res = await httpRequest({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        resultFormat: 'array',
        header: true,
        typesHeader: true,
        context: { sqlQueryId: queryId, timeout: ms },
      }),
      timeoutMs: ms,
    });
  } catch (e) {
    // Timed out or the socket died — cancel the broker-side query rather than
    // leaving it to run out its own timeout.
    try {
      await httpRequest({
        url: new URL(`/druid/v2/sql/${encodeURIComponent(queryId)}`, origin),
        method: 'DELETE',
        headers,
        timeoutMs: 5_000,
        maxBytes: 64 * 1024,
      });
    } catch {
      /* best effort */
    }
    return { ok: false, error: safeError(e, ctx.secrets) };
  }

  if (res.status < 200 || res.status >= 300) {
    const detail = res.body.trim().slice(0, 400);
    return {
      ok: false,
      error: safeError(new Error(detail ? `HTTP ${res.status}: ${detail}` : `Request failed (HTTP ${res.status})`), ctx.secrets),
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(res.body) as unknown;
  } catch {
    if (res.truncated) return { ok: false, error: CLIPPED };
    return { ok: false, error: safeError(new Error('Response was not valid JSON'), ctx.secrets) };
  }

  const all = asArray(json);
  const names = asArray(all[0]).map((v) => asString(v));
  const types = asArray(all[1]).map((v) => asString(v));
  const columns: ConnectorColumn[] = names.map((n, i) => ({ name: n, type: types[i] || 'unknown' }));
  const rows: Cell[][] = all.slice(2).map((row) => asArray(row).map(toCell));
  return capRows(columns, rows, ctx, res.truncated);
}

async function druidListTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const r = await druidRun(
    ctx,
    `SELECT TABLE_SCHEMA AS table_schema, TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA' ORDER BY 1, 2 LIMIT 1000`,
  );
  return isErr(r) ? r : tablesFromRows(r);
}

// ── the definitions ──────────────────────────────────────────────────────────

const TRINO: TrinoFlavor = { prefix: 'X-Trino', defaultPort: 8443 };
const PRESTO: TrinoFlavor = { prefix: 'X-Presto', defaultPort: 8443 };

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'clickhouse',
    label: 'ClickHouse',
    family: 'http',
    category: 'Query engines',
    readOnly: true,
    blurb: 'Reads over the HTTP interface with the readonly=2 setting set.',
    fields: [
      hostField('Hostname only — the scheme and port come from the fields below.'),
      portField(8443, '8443 for the TLS interface, 8123 for plain HTTP.'),
      { key: 'database', label: 'Database', type: 'text', default: 'default' },
      { key: 'user', label: 'User', type: 'text', default: 'default' },
      { key: 'password', label: 'Password', type: 'password', secret: true },
      INSECURE_FIELD,
    ],
    listTables: clickhouseListTables,
    run: clickhouseRun,
  },
  {
    id: 'databricks-sql',
    label: 'Databricks SQL',
    family: 'http',
    category: 'Query engines',
    readOnly: true,
    blurb: 'SQL warehouse over the Statement Execution API. https only.',
    fields: [
      { key: 'host', label: 'Workspace host', type: 'text', required: true, placeholder: 'dbc-1234abcd-5678.cloud.databricks.com' },
      { key: 'warehouseId', label: 'SQL warehouse ID', type: 'text', required: true, placeholder: '1234567890abcdef' },
      { key: 'token', label: 'Personal access token', type: 'password', required: true, secret: true },
      { key: 'catalog', label: 'Catalog', type: 'text', help: 'Optional. Unity Catalog name.' },
      { key: 'schema', label: 'Schema', type: 'text', help: 'Optional.' },
    ],
    listTables: databricksListTables,
    run: databricksRun,
  },
  {
    id: 'trino',
    label: 'Trino',
    family: 'http',
    category: 'Query engines',
    readOnly: true,
    blurb: 'Coordinator HTTP protocol. Results are paged and the query is cancelled if a cap is hit.',
    fields: [
      hostField('The coordinator hostname.'),
      portField(8443, '8443 for TLS, 8080 for the default plain-HTTP coordinator port.'),
      { key: 'user', label: 'User', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', secret: true, help: 'Optional. Sent as HTTP Basic — Trino rejects Basic over plain HTTP.' },
      { key: 'catalog', label: 'Catalog', type: 'text' },
      { key: 'schema', label: 'Schema', type: 'text' },
      INSECURE_FIELD,
    ],
    listTables: (ctx) => trinoListTables(ctx, TRINO),
    run: (ctx, sql) => trinoQuery(ctx, sql, TRINO),
  },
  {
    id: 'presto',
    label: 'Presto',
    family: 'http',
    category: 'Query engines',
    readOnly: true,
    blurb: 'Same wire protocol as Trino, with X-Presto-* headers.',
    fields: [
      hostField('The coordinator hostname.'),
      portField(8443, '8443 for TLS, 8080 for the default plain-HTTP coordinator port.'),
      { key: 'user', label: 'User', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', secret: true, help: 'Optional. Sent as HTTP Basic — Presto rejects Basic over plain HTTP.' },
      { key: 'catalog', label: 'Catalog', type: 'text' },
      { key: 'schema', label: 'Schema', type: 'text' },
      INSECURE_FIELD,
    ],
    listTables: (ctx) => trinoListTables(ctx, PRESTO),
    run: (ctx, sql) => trinoQuery(ctx, sql, PRESTO),
  },
  {
    id: 'elasticsearch',
    label: 'Elasticsearch',
    family: 'http',
    category: 'Query engines',
    readOnly: true,
    blurb: 'The _sql endpoint, whose grammar has no write statements.',
    fields: [
      hostField(),
      portField(9200, '9200 for a self-hosted node, 9243 on Elastic Cloud.'),
      { key: 'user', label: 'User', type: 'text', help: 'Leave blank when using an API key.' },
      { key: 'password', label: 'Password', type: 'password', secret: true },
      { key: 'apiKey', label: 'API key', type: 'password', secret: true, help: 'Used instead of user/password when set.' },
      INSECURE_FIELD,
    ],
    listTables: esListTables,
    run: esRun,
  },
  {
    id: 'opensearch',
    label: 'OpenSearch',
    family: 'http',
    category: 'Query engines',
    readOnly: true,
    blurb: 'The _plugins/_sql endpoint, which only speaks SELECT/SHOW/DESCRIBE.',
    fields: [
      hostField(),
      portField(9200, '9200 for a self-hosted node.'),
      { key: 'user', label: 'User', type: 'text' },
      { key: 'password', label: 'Password', type: 'password', secret: true },
      INSECURE_FIELD,
    ],
    listTables: osListTables,
    run: osRun,
  },
  {
    id: 'druid',
    label: 'Apache Druid',
    family: 'http',
    category: 'Query engines',
    readOnly: true,
    blurb: 'The query-only /druid/v2/sql endpoint — ingestion endpoints are never called.',
    fields: [
      hostField('The router or broker hostname.'),
      portField(8888, '8888 for the router, 8082 for a broker.'),
      { key: 'user', label: 'User', type: 'text', help: 'Optional. Only when basic-auth is enabled on the cluster.' },
      { key: 'password', label: 'Password', type: 'password', secret: true },
      INSECURE_FIELD,
    ],
    listTables: druidListTables,
    run: druidRun,
  },
];
