// Snowflake — MAIN PROCESS ONLY. Its own family, over the SQL API (HTTPS + JSON).
//
//   POST /api/v2/statements?requestId=<uuid>   {statement, timeout, warehouse,
//        database, schema, role, bindings, parameters}
//     200 → the result (partition 0 inline)          → GET …/<handle>?partition=N
//     202 → still running (after ~45 s, or at once)  → GET statementStatusUrl until 200
//     422 → the statement failed;  408 → it ran past `timeout`
//   POST /api/v2/statements/<handle>/cancel  — on abort or our own timeout
//
// Every statement carries QUERY_TAG `ordinate:<org>[:live|:extract]` (the bill
// can be read back per org and purpose), WEEK_START=1 and TIMEZONE=UTC (the
// live compiler's ISO weeks and UTC dates, plan L2.2), and
// MULTI_STATEMENT_COUNT=1: one statement per call, Snowflake refuses more.
//
// READ-ONLY: NOT ENFORCED BY THE ENGINE — the same label Databricks SQL, Trino
// and Presto carry (http.ts). The SQL API has no read-only session; the guard
// is the role the connection signs in with. Test connection WARNS when that is
// ACCOUNTADMIN, SYSADMIN or SECURITYADMIN, and docs/server/live-data.md gives
// the read-only role's SQL. `readOnly: true` means this app has no write path.
//
// BOUNDED (rule 3 of types.ts):
//   • rows — user SQL sits on its OWN LINE inside `select * from (\n…\n) limit
//     N+1` (rule F3: a trailing `--` comment cannot eat the cap), and the
//     client stops reading partitions once it holds more than N rows;
//   • time — `timeout` on the statement (Snowflake stops it itself) and our own
//     deadline over submit + polls + partitions; past it, or when ctx.signal
//     fires, the statement is CANCELLED, so a closed tab never leaves a
//     warehouse running. A submit still in flight when we give up has no
//     handle yet: its reply is awaited in the background and cancelled then;
//   • bytes — 100 MB across every response, compressed and decompressed.
//
// VALUES ARE BOUND, never inlined (plan D4): runBound sends `?` placeholders and
// `bindings` (snowflakeSql.ts); describeTable binds the schema and table name.
//
// Secrets: the private key, its passphrase and a PAT stay in this process. The
// bearer (JWT or PAT) is added to the redaction set of every error, beside the
// stored secrets, and nothing here logs. Response shaping is snowflakeShape.ts;
// sign-in and host building snowflakeAuth.ts; the socket snowflakeHttp.ts.

import { randomUUID } from 'node:crypto';
import { ctx as requestContext } from '../server/context';
import { adminRoleWarning } from './connectorMessages';
import { MAX_BYTES } from './http';
import { accountOrigin, authFor, type SfAccount, type SfAuth } from './snowflakeAuth';
import { snowflakeFetch, SfAbortError, type SfHttpResponse, type SfTransport } from './snowflakeHttp';
import { connectorColumns, shapeFirst, shapePartition, statusOf, type Cell, type ShapeMode } from './snowflakeShape';
import { buildBindings, cappedStatement, countPlaceholders, type SfBinding } from './snowflakeSql';
import { safeError } from './types';
import type { ConnectorContext, ConnectorDef, ConnectorError, ConnectorRows, ConnectorSchema, ConnectorTables, LiveParam } from './types';

// ── the transport seam ───────────────────────────────────────────────────────

let transport: SfTransport = snowflakeFetch;

/** Route every Snowflake request through `t`; null restores the real one. Tests only. */
export function setTransport(t: SfTransport | null): void {
  transport = t ?? snowflakeFetch;
}

// ── small helpers ────────────────────────────────────────────────────────────

function str(ctx: ConnectorContext, key: string): string {
  const v = ctx.values[key];
  return typeof v === 'string' ? v.trim() : '';
}
function bool(ctx: ConnectorContext, key: string): boolean {
  const v = ctx.values[key];
  return v === true || v === 'true' || v === 1 || v === '1';
}
/** Row cap: always at least 1, always finite. */
function rowCap(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.rowLimit);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
/** Wall clock for one operation: always finite and positive. */
function budgetMs(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.timeoutMs);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}
/** A trailing `;` would end the statement inside our wrapper. */
function cleanSql(sql: string): string {
  return String(sql || '').trim().replace(/;\s*$/, '');
}
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, '')) as unknown; // a BOM before the DOCUMENT only — never inside a value
  } catch {
    return undefined;
  }
}

// ── the request ─────────────────────────────────────────────────────────────

export interface SfRequest {
  ok: true;
  url: URL;
  headers: Record<string, string>;
  body: string;
  requestId: string;
  account: SfAccount;
  auth: SfAuth;
}

/** `ordinate:<org>`, plus `:live` / `:extract` when the caller says what the query is for. */
function queryTag(ctx: ConnectorContext): string {
  let org = '';
  try {
    org = requestContext().org.id;
  } catch {
    /* outside a request: no org to name */
  }
  return ['ordinate', org, ctx.costTag ?? ''].filter(Boolean).join(':');
}

/**
 * The submit request for `statement`, without sending it. Pure but for the
 * clock (`nowMs`, for the JWT) and the request id — exported so the self-check
 * reads the URL, headers and body a statement would go out with.
 */
export function buildRequest(
  ctx: ConnectorContext,
  statement: string,
  opts: { bindings?: Record<string, SfBinding>; requestId?: string; nowMs?: number } = {},
): SfRequest | ConnectorError {
  const account = accountOrigin(ctx.values.account, bool(ctx, 'privatelink'));
  if (!account.ok) return account;
  const warehouse = str(ctx, 'warehouse');
  if (!warehouse) return { ok: false, error: 'Warehouse is required' };
  const role = str(ctx, 'role');
  if (!role) return { ok: false, error: 'Role is required' };
  const auth = authFor(ctx, account, opts.nowMs);
  if (!auth.ok) return auth;

  const requestId = opts.requestId ?? randomUUID();
  const url = new URL('/api/v2/statements', account.origin);
  url.searchParams.set('requestId', requestId);
  const payload: Record<string, unknown> = {
    statement,
    timeout: Math.max(1, Math.ceil(budgetMs(ctx) / 1000)),
    warehouse,
    role,
    parameters: { QUERY_TAG: queryTag(ctx), WEEK_START: 1, TIMEZONE: 'UTC', MULTI_STATEMENT_COUNT: 1 },
  };
  const database = str(ctx, 'database');
  const schema = str(ctx, 'schema');
  if (database) payload.database = database;
  if (schema) payload.schema = schema;
  if (opts.bindings && Object.keys(opts.bindings).length) payload.bindings = opts.bindings;
  return {
    ok: true,
    url,
    headers: {
      authorization: `Bearer ${auth.token}`,
      'x-snowflake-authorization-token-type': auth.tokenType,
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-encoding': 'gzip',
    },
    body: JSON.stringify(payload),
    requestId,
    account,
    auth,
  };
}

// ── running a statement ──────────────────────────────────────────────────────

type Raced<T> = { kind: 'done'; value: T } | { kind: 'failed'; error: unknown } | { kind: 'timeout' } | { kind: 'aborted' };

/** `p`, or the deadline, or the caller's abort — whichever comes first. `p` itself is left running. */
function race<T>(p: Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<Raced<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: Raced<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = (): void => finish({ kind: 'aborted' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), Math.max(0, deadline - Date.now()));
    if (signal?.aborted) return finish({ kind: 'aborted' });
    // Checked here, not left to the timer: a reply that is already settled beats a
    // 0 ms timer every time, so a fast server would otherwise be polled forever.
    if (Date.now() >= deadline) return finish({ kind: 'timeout' });
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (value) => finish({ kind: 'done', value }),
      (error: unknown) => finish(error instanceof SfAbortError ? { kind: error.reason === 'timeout' ? 'timeout' : 'aborted' } : { kind: 'failed', error }),
    );
  });
}

const POLL_FIRST_MS = 200;
const POLL_MAX_MS = 1_500;
/** A submit may park up to ~45 s server side before its 202; the socket gets that long past our deadline. */
const SUBMIT_GRACE_MS = 50_000;
const CANCEL_TIMEOUT_MS = 5_000;
const CLIPPED = 'Response exceeded the 100 MB ceiling and was cut off — narrow the query or lower the row limit.';

/** The user-facing sentence for a non-2xx/202 reply. */
function failureOf(res: SfHttpResponse, json: unknown, budget: number): string {
  const st = statusOf(json);
  const detail = st.message || (json === undefined ? res.body.trim().slice(0, 300) : '');
  if (res.status === 401 || res.status === 403) return `Snowflake refused the sign-in (HTTP ${res.status})${detail ? ': ' + detail : ''}`;
  if (res.status === 408) return `The query ran past its ${Math.ceil(budget / 1000)}s limit and Snowflake stopped it.`;
  if (res.status === 429) return 'Snowflake is rate-limiting requests — try again in a minute.';
  if (res.status === 422 && detail) return st.code ? `Snowflake error ${st.code}: ${detail}` : detail;
  return detail ? `HTTP ${res.status}: ${detail}` : `Request failed (HTTP ${res.status})`;
}

/** Run one statement to completion and read its partitions, under ctx's caps, deadline and signal. */
async function execute(ctx: ConnectorContext, statement: string, mode: ShapeMode, bindings?: Record<string, SfBinding>): Promise<ConnectorRows | ConnectorError> {
  const req = buildRequest(ctx, statement, { bindings });
  if (!req.ok) return req;
  const redact = { ...ctx.secrets, bearer: req.auth.token };
  const fail = (e: unknown): ConnectorError => ({ ok: false, error: safeError(e, redact) });
  const budget = budgetMs(ctx);
  const deadline = Date.now() + budget;
  const stopped = (kind: 'timeout' | 'aborted'): ConnectorError =>
    ({ ok: false, error: kind === 'timeout' ? `Query timed out after ${Math.ceil(budget / 1000)}s` : 'The query was cancelled' });
  const origin = req.account.origin;
  const headers = req.headers;
  const handleUrl = (handle: string, suffix = ''): URL => new URL(`/api/v2/statements/${encodeURIComponent(handle)}${suffix}`, origin);
  // Best effort and silent: the answer is already decided, and a failed cancel must not replace it.
  const cancel = async (handle: string): Promise<void> => {
    try {
      await transport({ url: handleUrl(handle, '/cancel'), method: 'POST', headers, timeoutMs: CANCEL_TIMEOUT_MS, maxBytes: 64 * 1024 });
    } catch {
      /* nothing useful to do */
    }
  };
  let bytes = MAX_BYTES;
  const get = (url: URL): Promise<SfHttpResponse> =>
    transport({ url, method: 'GET', headers, timeoutMs: Math.max(1, deadline - Date.now()), maxBytes: Math.max(1, bytes), signal: ctx.signal });

  if (ctx.signal?.aborted) return stopped('aborted');
  // The submit is NOT given ctx.signal: destroying its socket would lose the
  // handle we need to cancel with. We stop waiting instead, and cancel when it lands.
  const submit = transport({ url: req.url, method: 'POST', headers, body: req.body, timeoutMs: budget + SUBMIT_GRACE_MS, maxBytes: bytes });
  const sent = await race(submit, ctx.signal, deadline);
  if (sent.kind === 'timeout' || sent.kind === 'aborted') {
    void submit.then(
      (res) => {
        const h = statusOf(parseJson(res.body)).handle;
        if (res.status === 202 && h) void cancel(h);
      },
      () => undefined,
    );
    return stopped(sent.kind);
  }
  if (sent.kind === 'failed') return fail(sent.error);

  let res = sent.value;
  let handle = '';
  let pause = POLL_FIRST_MS;
  let json: unknown;
  for (;;) {
    bytes -= Buffer.byteLength(res.body, 'utf8');
    json = parseJson(res.body);
    const st = statusOf(json);
    if (st.handle) handle = st.handle;
    if (res.status === 200) break;
    if (res.status !== 202) return fail(failureOf(res, json, budget));
    if (!handle) return fail('Snowflake accepted the statement without a handle');
    // Still running: wait, then ask again — at its statementStatusUrl, re-anchored on OUR origin.
    const waited = await race(new Promise<void>((r) => setTimeout(r, Math.min(pause, Math.max(0, deadline - Date.now())))), ctx.signal, deadline);
    if (waited.kind === 'timeout' || waited.kind === 'aborted') return cancel(handle).then(() => stopped(waited.kind as 'timeout' | 'aborted'));
    pause = Math.min(POLL_MAX_MS, Math.round(pause * 1.5));
    const path = st.statusUrl.startsWith('/api/v2/statements/') ? st.statusUrl : '';
    const next = await race(get(path ? new URL(path, origin) : handleUrl(handle)), ctx.signal, deadline);
    if (next.kind === 'timeout' || next.kind === 'aborted') return cancel(handle).then(() => stopped(next.kind as 'timeout' | 'aborted'));
    if (next.kind === 'failed') {
      await cancel(handle);
      return fail(next.error);
    }
    res = next.value;
  }

  if (json === undefined) return fail(res.truncated ? CLIPPED : 'Response was not valid JSON');
  const first = shapeFirst(json, mode);
  if (!first.ok) return fail(first.error);
  const cap = rowCap(ctx);
  const rows: Cell[][] = first.rows;
  let truncated = false;
  // The statement is finished: from here a stop only stops reading — nothing runs to cancel.
  for (let p = 1; p < first.partitions && rows.length <= cap; p++) {
    if (bytes <= 0 || !handle) {
      truncated = true;
      break;
    }
    const url = handleUrl(handle);
    url.searchParams.set('partition', String(p));
    const got = await race(get(url), ctx.signal, deadline);
    if (got.kind === 'timeout' || got.kind === 'aborted') return stopped(got.kind);
    if (got.kind === 'failed') return fail(got.error);
    const page = got.value;
    bytes -= Buffer.byteLength(page.body, 'utf8');
    const pj = parseJson(page.body);
    if (page.status !== 200) return fail(failureOf(page, pj, budget));
    if (pj === undefined) {
      if (page.truncated) { truncated = true; break; }
      return fail('Response was not valid JSON');
    }
    for (const row of shapePartition(pj, first.columns, mode)) rows.push(row); // a loop: a spread of 100k rows overflows the stack
  }
  return {
    ok: true,
    columns: connectorColumns(first.columns),
    rows: rows.length > cap ? rows.slice(0, cap) : rows,
    truncated: truncated || rows.length > cap,
  };
}

// ── the operations ──────────────────────────────────────────────────────────

async function run(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const statement = cleanSql(sql);
  if (!statement) return { ok: false, error: 'No query specified' };
  return execute(ctx, cappedStatement(statement, rowCap(ctx)), 'extract');
}

/** The live capability: one compiled statement, `?` placeholders bound from `params` (never inlined). */
async function runBound(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<ConnectorRows | ConnectorError> {
  const statement = cleanSql(sql);
  if (!statement) return { ok: false, error: 'No query specified' };
  const list = Array.isArray(params) ? params : [];
  const holes = countPlaceholders(statement);
  if (holes !== list.length) return { ok: false, error: `The statement has ${holes} placeholders but ${list.length} parameters` };
  const bound = buildBindings(list);
  if (!bound.ok) return bound;
  return execute(ctx, cappedStatement(statement, rowCap(ctx)), 'live', bound.bindings);
}

const ADMIN_ROLES: ReadonlySet<string> = new Set(['ACCOUNTADMIN', 'SYSADMIN', 'SECURITYADMIN']);

/** The configured role, as Snowflake resolves it (an unquoted name is upper-cased), when it is an administrator. */
export function adminRole(role: unknown): string | null {
  const name = (typeof role === 'string' ? role.trim() : '').replace(/^"(.*)"$/, '$1').toUpperCase();
  return ADMIN_ROLES.has(name) ? name : null;
}

/** Tables (and views) of the connection's database; without one, every table the role can see. */
async function listTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const db = str(ctx, 'database');
  const sql = db
    ? "select table_schema, table_name from information_schema.tables where table_schema <> 'INFORMATION_SCHEMA' order by 1, 2 limit 1000"
    : 'show terse tables in account limit 1000';
  const r = await execute(ctx, sql, 'extract');
  if (!r.ok) return r;
  const at = (...names: string[]): number => r.columns.findIndex((c) => names.includes(c.name.toLowerCase()));
  const name = at('table_name', 'name');
  const schema = at('table_schema', 'schema_name');
  const database = at('database_name');
  const tables = r.rows
    .map((row) => {
      const parts = [database, schema].filter((i) => i >= 0).map((i) => row[i]).filter((v) => v !== null && v !== '');
      return { schema: parts.length ? parts.join('.') : undefined, name: row[name] == null ? '' : String(row[name]) };
    })
    .filter((t) => t.name);
  const admin = adminRole(ctx.values.role);
  return admin ? { ok: true, tables, warnings: [adminRoleWarning(admin)] } : { ok: true, tables };
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

/** One table's columns from INFORMATION_SCHEMA, the schema and table name BOUND. */
async function describeTable(ctx: ConnectorContext, table: string): Promise<ConnectorSchema | ConnectorError> {
  const parts = String(table ?? '').split('.');
  if (parts.length > 3 || parts.some((p) => !p)) return { ok: false, error: 'Invalid table name' };
  // A database part names WHICH information_schema — an identifier, so whitelisted and quoted, never bound.
  if (parts.length === 3 && !IDENT_RE.test(parts[0])) return { ok: false, error: 'Invalid table name' };
  const from = parts.length === 3 ? `"${parts[0]}".information_schema` : 'information_schema';
  const name = parts[parts.length - 1];
  const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
  const sql = [
    'select c.column_name, c.data_type, c.is_nullable, c.numeric_precision, c.numeric_scale, t.row_count',
    `from ${from}.columns c left join ${from}.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name`,
    `where c.table_schema = ${schema === null ? 'current_schema()' : '?'} and c.table_name = ?`,
    'order by c.ordinal_position limit 10000',
  ].join('\n');
  const bound = buildBindings([
    ...(schema === null ? [] : [{ name: 'p0', type: 'text' as const, value: schema }]),
    { name: 'p1', type: 'text', value: name },
  ]);
  if (!bound.ok) return bound;
  const r = await execute(ctx, sql, 'extract', bound.bindings);
  if (!r.ok) return r;
  if (r.rows.length === 0) return { ok: false, error: 'No such table, or the role cannot see it' };
  const columns = r.rows.map(([col, type, nullable, precision, scale]) => ({
    name: String(col ?? ''),
    type: type === 'NUMBER' && precision !== null ? `NUMBER(${String(precision)},${String(scale ?? 0)})` : String(type ?? ''),
    nullable: nullable === 'YES',
  }));
  const estimate = Number(r.rows[0][5]);
  return r.rows[0][5] !== null && Number.isFinite(estimate) ? { ok: true, columns, rowEstimate: estimate } : { ok: true, columns };
}

// ── the definition ──────────────────────────────────────────────────────────

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'snowflake',
    label: 'Snowflake',
    family: 'snowflake',
    category: 'Cloud warehouses',
    readOnly: true,
    blurb: 'SQL API over HTTPS. Read-only is not enforced by Snowflake: sign in with a read-only role.',
    fields: [
      {
        key: 'account', label: 'Account', type: 'text', required: true, placeholder: 'myorg-myaccount',
        help: 'Your account identifier — myorg-myaccount, or a locator such as xy12345.us-east-2.aws. Not a URL: Ordinate builds the address itself.',
      },
      {
        key: 'privatelink', label: 'Connect over PrivateLink', type: 'checkbox', default: false,
        help: 'Uses <account>.privatelink.snowflakecomputing.com, which resolves inside your network — an administrator allows its range with SSRF_ALLOW.',
      },
      { key: 'user', label: 'User', type: 'text', required: true, help: 'The Snowflake user this connection signs in as.' },
      {
        key: 'auth', label: 'Sign-in', type: 'select', required: true, default: 'keypair',
        options: [{ value: 'keypair', label: 'Key pair' }, { value: 'pat', label: 'Programmatic access token' }],
        help: 'No password-only sign-in: Snowflake is retiring it.',
      },
      {
        key: 'token', label: 'Private key or access token', type: 'textarea', secret: true, required: true, placeholder: '-----BEGIN PRIVATE KEY-----',
        help: 'Key pair: the PEM private key (PKCS#8, encrypted or not). Programmatic access token: the token.',
      },
      { key: 'password', label: 'Private key passphrase', type: 'password', secret: true, help: 'Only for an encrypted private key.' },
      { key: 'warehouse', label: 'Warehouse', type: 'text', required: true, placeholder: 'COMPUTE_WH' },
      {
        key: 'role', label: 'Role', type: 'text', required: true, placeholder: 'ORDINATE_READER',
        help: 'A read-only role. Test connection warns about ACCOUNTADMIN, SYSADMIN and SECURITYADMIN.',
      },
      { key: 'database', label: 'Database', type: 'text', help: 'Optional. Lists this database’s tables; without it, every table the role can see.' },
      { key: 'schema', label: 'Schema', type: 'text', help: 'Optional. The default schema for queries.' },
    ],
    listTables,
    run,
    describeTable,
    live: { dialect: 'snowflake', runBound },
  },
];
