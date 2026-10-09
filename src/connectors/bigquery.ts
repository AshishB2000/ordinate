// Google BigQuery — MAIN PROCESS ONLY. Its own family: a REST API over HTTPS
// with a service-account key, not a wire protocol another source shares.
//
//   sign-in    a JWT signed with the key → oauth2.googleapis.com/token (./bigqueryAuth.ts)
//   query      POST /bigquery/v2/projects/<p>/queries (jobs.query), an incomplete
//              job polled with getQueryResults, pages followed by pageToken
//   catalog    datasets.list + tables.list (the tree), tables.get (one table)
//   cancel     POST …/jobs/<id>/cancel on abort or timeout
//
// The request and response SHAPING is ./bigqueryShape.ts (pure, unit-tested off
// recorded fixtures); this file is the transport and the job loop.
//
// NETWORK. Two fixed hosts, declared on the def (`hosts`), and every request —
// the token exchange included — goes through http.ts's httpRequest, which on
// the server resolves, checks and pins each host (ssrf.ts). A URL whose host is
// not on the list is refused before the transport is called. The user never
// types a host: the project id is validated and URL-encoded into a path.
//
// READ-ONLY, belt and braces (plan L1.3; the scope spike is unverified):
//   1. the token carries only read-only scopes (bigqueryAuth.ts), and
//   2. every statement `run` sends is DRY-RUN first (free) and refused unless
//      BigQuery says its `statementType` is SELECT — the exact text that then
//      runs, wrapper included, so a closed parenthesis cannot smuggle a script.
//   `live.runBound` skips (2): its SQL is compiled by the app from a validated
//   spec, never typed by a user, and a dry run would double every chart's latency.
//   The IAM roles (Data Viewer + Job User, docs/server/live-data.md) are the
//   boundary Google enforces whatever the scope.
//
// COST (plan D9). Every query that can bill carries `maximumBytesBilled` =
// min(connection field, LIVE_MAX_BYTES_BILLED, ctx.maxBytes): BigQuery fails
// it before it runs, at no charge. A dry run over that is refused up front with
// the size. `jobTimeoutMs` makes BigQuery stop a job on its own if we are gone;
// on abort (the client hung up, ctx.signal) or our own timeout the job is
// CANCELLED — with a cancel-only token, since no read-only scope covers it.
// A finished query's rows carry the bytes BigQuery says it billed (`bytes`,
// from the reply), which Live counts per connection per day (L2.7).
//
// SECRETS. The key arrives in ctx.secrets.token (plan L1.1: the `token` slot)
// and leaves only as a signature. Every error is scrubbed of the key file, the
// PEM and each of its lines, the key id, the assertion and any access token.

import { httpRequest, MAX_BYTES } from './http';
import type { HttpRequestOptions, HttpResult } from './http';
import { accessToken, CANCEL_SCOPES, parseKey, READ_SCOPES, readTokenReply, TOKEN_HOST, tokenRequest } from './bigqueryAuth';
import type { ServiceAccountKey } from './bigqueryAuth';
import {
  apiError, billedBytesOf, BQ_HOST, buildRequest, bytesCap, cancelUrl, capSql, datasetsUrl, describeColumns, estimateLabel, jobOf,
  parseDatasetRef, parseTablePath, prop, queriesUrl, resultsUrl, shapeResponse, tablesUrl, tableUrl, validDataset,
  validLocation, validProject,
} from './bigqueryShape';
import type { Job } from './bigqueryShape';
import { safeError } from './types';
import type { ConnectorContext, ConnectorDef, ConnectorError, ConnectorRows, ConnectorSchema, ConnectorTable, ConnectorTables, LiveParam } from './types';
import { ctx as requestContext } from '../server/context';
import { DEFAULT_MAX_BYTES_BILLED, maxBytesBilled } from '../server/liveEnv';

export const HOSTS: readonly string[] = [BQ_HOST, TOKEN_HOST];

const WAIT_MAX_MS = 10_000; // how long BigQuery may hold one request open for the job
const POLL_GAP_MS = 50; // between two getQueryResults calls on an unfinished job
const PAGE_ROWS = 50_000; // rows asked per page (BigQuery also cuts a page at 10 MB)
const LIST_CAP = 1_000; // tables in the tree, as the SQL families' `LIMIT 1000`
const CANCEL_MS = 5_000;
const CANCELLED = 'The query was cancelled, and the BigQuery job with it.';

// ── the transport seam ──────────────────────────────────────────────────────

export type Transport = (opts: HttpRequestOptions) => Promise<HttpResult>;
let transport: Transport = httpRequest;

/** Route every BigQuery request through `t`; null restores httpRequest. Tests only. */
export function setTransport(t: Transport | null): void {
  transport = t || httpRequest;
}

/** The one door to the network: https, a declared host, then the transport. Exported for its negative control. */
export async function send(opts: HttpRequestOptions): Promise<HttpResult> {
  if (opts.url.protocol !== 'https:' || !HOSTS.includes(opts.url.hostname)) {
    throw new Error(`Refused: ${opts.url.hostname || 'that address'} is not a host this source declares (${HOSTS.join(', ')}).`);
  }
  return transport(opts);
}

const ABORTED: unique symbol = Symbol('aborted');

/** `p`, or ABORTED as soon as `signal` fires — the request itself runs out its own timeout. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener('abort', onAbort), resolve(v)),
      (e: unknown) => (signal.removeEventListener('abort', onAbort), reject(e)),
    );
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── one connection ──────────────────────────────────────────────────────────

interface Conn {
  project: string;
  key: ServiceAccountKey;
  location?: string;
  defaultDataset?: { projectId: string; datasetId: string };
  maxBytes: number;
  /** safeError's list: ctx.secrets, the key's fragments, and each token once minted. */
  secrets: Record<string, string>;
}

const err = (error: string): ConnectorError => ({ ok: false, error });

/**
 * Every secret out of a raw reply BEFORE anything slices it: a reply cut at
 * 300 characters could otherwise keep half a token that the final safeError
 * pass no longer recognises.
 */
function scrubText(body: string, secrets: Record<string, string>): string {
  let out = body;
  for (const v of Object.values(secrets)) if (v && v.length >= 3) out = out.split(v).join('***');
  return out;
}
const field = (ctx: ConnectorContext, k: string): string => {
  const v = ctx.values[k];
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
};

/** LIVE_MAX_BYTES_BILLED, re-read per query (env.ts refused a bad value at startup). */
function ceiling(): number {
  try {
    return maxBytesBilled(process.env.LIVE_MAX_BYTES_BILLED);
  } catch {
    return DEFAULT_MAX_BYTES_BILLED;
  }
}

function connOf(ctx: ConnectorContext): Conn | ConnectorError {
  const key = parseKey(typeof ctx.secrets.token === 'string' ? ctx.secrets.token : '');
  if ('ok' in key) return key;
  const project = field(ctx, 'project') || key.projectId || '';
  if (!project) return err('Billing project is required: the key names no project.');
  if (!validProject(project)) return err('The billing project must be a Google Cloud project id, such as my-project-123.');
  const location = field(ctx, 'location');
  if (location && !validLocation(location)) return err('Location must be a BigQuery location such as US, EU or europe-west2.');
  const dataset = field(ctx, 'dataset');
  const defaultDataset = dataset ? parseDatasetRef(dataset, project) : null;
  if (dataset && !defaultDataset) return err('The default dataset must be a dataset id (letters, digits, underscores), or project.dataset.');
  const secrets: Record<string, string> = { ...ctx.secrets };
  key.scrub.forEach((s, i) => { secrets[`key${i}`] = s; });
  const c: Conn = { project, key, maxBytes: bytesCap(ctx.values.maxBytesBilled, ceiling(), ctx.maxBytes), secrets };
  if (location) c.location = location;
  if (defaultDataset) c.defaultDataset = defaultDataset;
  return c;
}

/** The caller's give-up signal: the connector's own, else the request's (a closed tab). */
function signalOf(ctx: ConnectorContext): AbortSignal | undefined {
  if (ctx.signal) return ctx.signal;
  try {
    return requestContext().signal;
  } catch {
    return undefined; // a server job outside a request: its own timeout bounds it
  }
}

function budgetMs(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.timeoutMs);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}
function rowCap(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.rowLimit);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
const cleanSql = (sql: string): string => String(sql || '').trim().replace(/;\s*$/, '');

// ── requests ────────────────────────────────────────────────────────────────

type Reply = { ok: true; json: unknown; clipped: boolean; bytes: number } | (ConnectorError & { aborted?: true });

interface Call {
  url: URL;
  method: 'GET' | 'POST';
  token: string;
  body?: Record<string, unknown>;
  timeoutMs: number;
  maxBytes?: number;
}

/**
 * One authorised JSON request, raced against `signal`. When the race is lost
 * to an abort, `onLate` still sees the reply when it lands — how a job whose
 * id we did not have yet gets cancelled.
 */
async function callJson(conn: Conn, c: Call, signal: AbortSignal | undefined, onLate?: (json: unknown) => void): Promise<Reply> {
  if (signal?.aborted) return { ok: false, error: CANCELLED, aborted: true };
  const headers: Record<string, string> = { authorization: `Bearer ${c.token}` };
  if (c.body) headers['content-type'] = 'application/json';
  const pending = send({
    url: c.url, method: c.method, headers, timeoutMs: Math.max(1, c.timeoutMs),
    ...(c.body ? { body: JSON.stringify(c.body) } : {}), ...(c.maxBytes ? { maxBytes: c.maxBytes } : {}),
  });
  let res: HttpResult | typeof ABORTED;
  try {
    res = await untilAborted(pending, signal);
  } catch (e) {
    return err(safeError(e, conn.secrets));
  }
  if (res === ABORTED) {
    if (onLate) pending.then((r) => { try { onLate(JSON.parse(r.body)); } catch { /* nothing to cancel */ } }, () => undefined);
    return { ok: false, error: CANCELLED, aborted: true };
  }
  const bytes = Buffer.byteLength(res.body, 'utf8');
  if (res.status < 200 || res.status >= 300) return err(safeError(apiError(res.status, scrubText(res.body, conn.secrets)), conn.secrets));
  try {
    return { ok: true, json: JSON.parse(res.body) as unknown, clipped: res.truncated, bytes };
  } catch {
    return res.truncated ? { ok: true, json: undefined, clipped: true, bytes } : err('BigQuery sent a reply that is not JSON.');
  }
}

/** A token for `scopes`, minted through the guarded transport and scrubbed from errors from then on. */
async function tokenFor(conn: Conn, scopes: readonly string[], signal: AbortSignal | undefined): Promise<{ ok: true; token: string } | ConnectorError> {
  const exchange = async (assertion: string) => {
    const req = tokenRequest(assertion);
    const scrub = { ...conn.secrets, assertion };
    try {
      const res = await send({ url: req.url, method: 'POST', headers: req.headers, body: req.body, timeoutMs: 15_000, maxBytes: 64 * 1024 });
      const r = readTokenReply(res.status, res.status >= 200 && res.status < 300 ? res.body : scrubText(res.body, scrub));
      return r.ok ? r : err(safeError(r.error, scrub));
    } catch (e) {
      return err(safeError(e, scrub));
    }
  };
  // The exchange is shared by concurrent callers, so it is never cut short by
  // one caller's abort; only this caller's wait is.
  const r = await untilAborted(accessToken(conn.key, scopes, exchange), signal);
  if (r === ABORTED) return err(CANCELLED);
  if (r.ok) conn.secrets[`token:${scopes.join(' ')}`] = r.token;
  return r;
}

/** Best effort, bounded, silent: the result is already decided, and jobTimeoutMs stops the job anyway. */
async function cancelJob(conn: Conn, job: Job): Promise<void> {
  try {
    const t = await tokenFor(conn, CANCEL_SCOPES, undefined);
    if (!t.ok) return;
    await send({ url: cancelUrl(job), method: 'POST', headers: { authorization: `Bearer ${t.token}` }, timeoutMs: CANCEL_MS, maxBytes: 64 * 1024 });
  } catch {
    /* nothing useful to do */
  }
}

const reqOpts = (conn: Conn) => ({
  ...(conn.location ? { location: conn.location } : {}),
  ...(conn.defaultDataset ? { defaultDataset: conn.defaultDataset } : {}),
});

/** The free dry run: what the statement is and how many bytes it would read. */
async function dryRun(conn: Conn, token: string, sql: string, params: readonly LiveParam[], signal: AbortSignal | undefined, deadline: number): Promise<{ ok: true; statementType: string; bytes: number } | ConnectorError> {
  const req = buildRequest(sql, params, { ...reqOpts(conn), maxBytes: conn.maxBytes, label: 'extract', waitMs: 0, jobTimeoutMs: 0, maxResults: 0, dryRun: true });
  if (!req.ok) return req;
  const r = await callJson(conn, { url: queriesUrl(conn.project), method: 'POST', token, body: req.body, timeoutMs: deadline - Date.now() }, signal);
  if (!r.ok) return r;
  const raw = prop(r.json, 'statementType');
  const bytes = Number(prop(r.json, 'totalBytesProcessed'));
  return { ok: true, statementType: typeof raw === 'string' && /^[A-Z_]{1,40}$/.test(raw) ? raw : '', bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : 0 };
}

/** The read-only gate: SELECT, under the bytes cap — or a refusal that says which. */
async function gate(conn: Conn, token: string, sql: string, params: readonly LiveParam[], signal: AbortSignal | undefined, deadline: number): Promise<{ ok: true; bytes: number } | ConnectorError> {
  const dry = await dryRun(conn, token, sql, params, signal, deadline);
  if (!dry.ok) return dry;
  if (dry.statementType !== 'SELECT') {
    return err(`Refused: only SELECT statements run on BigQuery here, and the dry run says this is ${dry.statementType ? `a ${dry.statementType} statement` : 'not a plain SELECT'}.`);
  }
  return { ok: true, bytes: dry.bytes };
}

// ── a query, end to end ─────────────────────────────────────────────────────

async function execute(ctx: ConnectorContext, sql: string, params: readonly LiveParam[], how: { gate: boolean; label: 'live' | 'extract' }): Promise<ConnectorRows | ConnectorError> {
  const conn = connOf(ctx);
  if ('ok' in conn) return conn;
  const signal = signalOf(ctx);
  const budget = budgetMs(ctx);
  const deadline = Date.now() + budget;
  const cap = rowCap(ctx);
  const token = await tokenFor(conn, READ_SCOPES, signal);
  if (!token.ok) return token;

  if (how.gate) {
    const g = await gate(conn, token.token, sql, params, signal, deadline);
    if (!g.ok) return g;
    if (g.bytes > conn.maxBytes) {
      return err(`Refused before running: this query would process ${estimateLabel(g.bytes).slice(1)}, over this connection's limit of ${estimateLabel(conn.maxBytes).slice(1)} billed per query. Narrow it, or raise "Max bytes billed per query" (the server caps it with LIVE_MAX_BYTES_BILLED).`);
    }
  }

  const waitMs = (): number => Math.max(0, Math.min(WAIT_MAX_MS, deadline - Date.now() - 2_000));
  const req = buildRequest(sql, params, {
    ...reqOpts(conn), maxBytes: conn.maxBytes, label: how.label, waitMs: waitMs(), jobTimeoutMs: budget, maxResults: Math.min(cap + 1, PAGE_ROWS),
  });
  if (!req.ok) return req;

  let job: Job | null = null;
  let complete = false;
  const lateCancel = (json: unknown): void => {
    const j = jobOf(json, conn.location);
    if (j && prop(json, 'jobComplete') !== true) void cancelJob(conn, j);
  };
  let reply = await callJson(conn, { url: queriesUrl(conn.project), method: 'POST', token: token.token, body: req.body, timeoutMs: deadline - Date.now() }, signal, lateCancel);
  let byteBudget = MAX_BYTES;
  let schema: unknown;
  let billed: number | undefined;
  const rows: unknown[] = [];
  let clipped = false;

  for (;;) {
    if (!reply.ok) {
      // Aborted, timed out or refused mid-way: a job still running is cancelled.
      if (job && !complete) await cancelJob(conn, job);
      return reply;
    }
    if (reply.json === undefined) { clipped = true; break; } // a page cut at the byte ceiling
    byteBudget -= reply.bytes;
    job = job ?? jobOf(reply.json, conn.location);
    let next: { pageToken?: string; maxResults?: number; timeoutMs?: number };
    if (prop(reply.json, 'jobComplete') !== true) {
      if (!job) return err('BigQuery did not say which job is running.');
      if (deadline - Date.now() <= 0) {
        await cancelJob(conn, job);
        return err(`BigQuery did not finish within ${Math.max(1, Math.round(budget / 1000))}s, so the job was cancelled.`);
      }
      await untilAborted(sleep(POLL_GAP_MS), signal);
      next = { maxResults: Math.min(cap + 1, PAGE_ROWS), timeoutMs: waitMs() };
    } else {
      complete = true;
      schema = schema ?? prop(reply.json, 'schema');
      billed = billed ?? billedBytesOf(reply.json); // the reply that finished the job says what it billed
      for (const r of Array.isArray(prop(reply.json, 'rows')) ? (prop(reply.json, 'rows') as unknown[]) : []) rows.push(r);
      const pageToken = prop(reply.json, 'pageToken');
      if (rows.length > cap || typeof pageToken !== 'string' || !pageToken) break;
      if (!job) return err('BigQuery did not say which job holds the rest of the result.');
      if (byteBudget <= 0 || deadline - Date.now() <= 0) { clipped = true; break; }
      next = { pageToken, maxResults: Math.min(cap + 1 - rows.length, PAGE_ROWS) };
    }
    if (signal?.aborted) {
      if (job && !complete) await cancelJob(conn, job);
      return err(CANCELLED);
    }
    reply = await callJson(conn, { url: resultsUrl(job!, next), method: 'GET', token: token.token, timeoutMs: deadline - Date.now(), maxBytes: Math.max(1, byteBudget) }, signal);
  }
  const shaped = shapeResponse({ schema, rows }, ctx, clipped);
  if (shaped.ok && billed !== undefined) shaped.bytes = billed;
  return shaped;
}

// ── catalog ─────────────────────────────────────────────────────────────────

async function listTables(ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
  const conn = connOf(ctx);
  if ('ok' in conn) return conn;
  const signal = signalOf(ctx);
  const deadline = Date.now() + budgetMs(ctx);
  const token = await tokenFor(conn, READ_SCOPES, signal);
  if (!token.ok) return token;
  const get = (url: URL) => callJson(conn, { url, method: 'GET', token: token.token, timeoutMs: deadline - Date.now() }, signal);

  const datasets: string[] = [];
  let pageToken: unknown = '';
  do {
    const r = await get(datasetsUrl(conn.project, String(pageToken || '')));
    if (!r.ok) return r;
    for (const d of Array.isArray(prop(r.json, 'datasets')) ? (prop(r.json, 'datasets') as unknown[]) : []) {
      const id = prop(prop(d, 'datasetReference'), 'datasetId');
      if (typeof id === 'string' && validDataset(id)) datasets.push(id);
    }
    pageToken = prop(r.json, 'nextPageToken');
  } while (typeof pageToken === 'string' && pageToken && datasets.length < LIST_CAP && deadline - Date.now() > 2_000);

  // The default dataset first: it is the one unqualified names resolve to.
  const first = conn.defaultDataset?.projectId === conn.project ? conn.defaultDataset.datasetId : '';
  if (first && datasets.includes(first)) datasets.sort((a, b) => Number(b === first) - Number(a === first));

  const tables: ConnectorTable[] = [];
  let failed: ConnectorError | null = null;
  for (const ds of datasets) {
    let pt: unknown = '';
    do {
      if (tables.length >= LIST_CAP || deadline - Date.now() <= 2_000) return { ok: true, tables: tables.slice(0, LIST_CAP) };
      const r = await get(tablesUrl(conn.project, ds, String(pt || '')));
      // One dataset this account cannot list costs that dataset, not the tree.
      if (!r.ok) { failed = failed ?? r; break; }
      for (const t of Array.isArray(prop(r.json, 'tables')) ? (prop(r.json, 'tables') as unknown[]) : []) {
        const name = prop(prop(t, 'tableReference'), 'tableId');
        if (typeof name === 'string' && parseTablePath(`${ds}.${name}`)) tables.push({ schema: ds, name });
      }
      pt = prop(r.json, 'nextPageToken');
    } while (typeof pt === 'string' && pt);
  }
  return tables.length === 0 && failed ? failed : { ok: true, tables: tables.slice(0, LIST_CAP) };
}

async function describeTable(ctx: ConnectorContext, table: string): Promise<ConnectorSchema | ConnectorError> {
  const path = parseTablePath(table);
  if (!path) return err('Name a table as dataset.table or project.dataset.table.');
  const conn = connOf(ctx);
  if ('ok' in conn) return conn;
  const signal = signalOf(ctx);
  const token = await tokenFor(conn, READ_SCOPES, signal);
  if (!token.ok) return token;
  const r = await callJson(conn, { url: tableUrl(conn.project, path), method: 'GET', token: token.token, timeoutMs: budgetMs(ctx) }, signal);
  if (!r.ok) return r;
  const out: ConnectorSchema = { ok: true, columns: describeColumns(r.json) };
  const n = Number(prop(r.json, 'numRows'));
  if (prop(r.json, 'numRows') !== undefined && Number.isFinite(n) && n >= 0) out.rowEstimate = n;
  return out;
}

// ── the capabilities ────────────────────────────────────────────────────────

async function run(ctx: ConnectorContext, sql: string): Promise<ConnectorRows | ConnectorError> {
  const statement = cleanSql(sql);
  if (!statement) return err('No query specified');
  return execute(ctx, capSql(statement, rowCap(ctx)), [], { gate: true, label: ctx.costTag ?? 'extract' });
}

async function runBound(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<ConnectorRows | ConnectorError> {
  const statement = cleanSql(sql);
  if (!statement) return err('No query specified');
  return execute(ctx, capSql(statement, rowCap(ctx)), params, { gate: false, label: ctx.costTag ?? 'live' });
}

/** The editor's "~1.2 GB" and live's cost check: a dry run, refused unless it is a SELECT. */
async function estimate(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<{ ok: true; bytes: number } | ConnectorError> {
  const statement = cleanSql(sql);
  if (!statement) return err('No query specified');
  const conn = connOf(ctx);
  if ('ok' in conn) return conn;
  const signal = signalOf(ctx);
  const token = await tokenFor(conn, READ_SCOPES, signal);
  if (!token.ok) return token;
  return gate(conn, token.token, statement, params, signal, Date.now() + budgetMs(ctx));
}

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'bigquery',
    label: 'Google BigQuery',
    family: 'bigquery',
    category: 'Cloud warehouses',
    readOnly: true,
    blurb: 'A read-only service account over the REST API. Every query is dry-run first and capped by bytes billed.',
    hosts: HOSTS,
    fields: [
      { key: 'project', label: 'Billing project', type: 'text', placeholder: 'my-project-123', help: 'Queries run, and are billed, here. Blank uses the key\'s own project.' },
      {
        key: 'token', label: 'Service-account key (JSON)', type: 'textarea', required: true, secret: true,
        help: 'Paste the whole key file. Grant the account BigQuery Data Viewer and BigQuery Job User only.',
      },
      { key: 'dataset', label: 'Default dataset', type: 'text', placeholder: 'analytics', help: 'Optional. Unqualified table names resolve here.' },
      { key: 'location', label: 'Location', type: 'text', placeholder: 'US', help: 'Optional. Where jobs run: US, EU or a region such as europe-west2.' },
      {
        key: 'maxBytesBilled', label: 'Max bytes billed per query', type: 'number', placeholder: '10737418240',
        help: 'A query that would bill more fails before it runs, at no charge. The server caps it (LIVE_MAX_BYTES_BILLED, 10 GiB by default).',
      },
    ],
    listTables,
    run,
    describeTable,
    live: { dialect: 'bigquery', runBound, estimate },
  },
];
