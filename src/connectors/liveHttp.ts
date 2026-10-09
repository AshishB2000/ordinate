// The Live capability of two HTTP engines — ClickHouse and Databricks SQL
// (docs/live-data/00-plan.md L2.1, D2, D4) — MAIN PROCESS ONLY.
//
// `runBound` runs ONE statement the live compiler wrote, with its values bound
// by the warehouse, never spliced into the text:
//
//   clickhouse  `{p0:String}` placeholders in the SQL; each value rides in the
//               URL as `param_p0=…`, which ClickHouse parses as a typed value
//               (TabSeparated escaping: a backslash, tab or newline is
//               escaped, a quote is inert). The read-only `readonly=2`, the row
//               cap and the time cap are the same settings `run` sends, plus
//               `cancel_http_readonly_queries_on_client_close=1` so the abort
//               that destroys our socket also stops the query.
//   databricks  `:p0` markers; `parameters: [{name, value, type}]` on the
//               Statement Execution API. Submitted with `wait_timeout: 0s` so
//               the statement id comes back at once and an abort or a blown
//               budget can POST `…/cancel` — a closed tab never leaves a
//               warehouse running (plan D9). A NULL is a parameter without
//               `value`, per the API.
//
// The request builders are exported and pure, because the self-check pins the
// one property that matters — an adversarial literal reaches the warehouse as a
// parameter and never as SQL text — without a warehouse.
//
// UNVERIFIED without a live server, like http.ts's own notes: ClickHouse's
// escaping of `param_` values and Databricks' acceptance of a `Z`-suffixed
// TIMESTAMP parameter are from the vendors' documentation and client libraries.
// L2.8 runs the parity matrix against real engines; until then these are the
// sites to look at first.

import type { ConnectorContext, ConnectorError, ConnectorLive, ConnectorRows, LiveParam } from './types';
import { safeError } from './types';
import {
  asArray, asString, budgetMs, buildBase, CANCELLED, capRows, cleanSql, CLIPPED, isErr, prop, requestJson, rowCap,
  secret, shapeClickhouse, shapeDatabricks, str, timeoutError, toCell, type Cell, type HttpRequestOptions, type JsonResult,
} from './httpShared';
import { checkParams, isParamError, utcWallClock } from './liveParams';

// ── ClickHouse ───────────────────────────────────────────────────────────────

/** A value in ClickHouse's escaped text form — what a `param_` value is parsed as. */
export function clickhouseParamValue(p: LiveParam): string {
  if (p.value === null) return '\\N';
  if (p.type === 'boolean') return p.value ? '1' : '0';
  if (p.type === 'number') return String(p.value);
  const text = p.type === 'timestamp' ? utcWallClock(String(p.value)) : String(p.value);
  return text.replace(/[\\\t\n\r\0']/g, (c) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r', '\0': '\\0', "'": "\\'" })[c] as string);
}

/** The request `runBound` sends: settings and parameters in the URL, the statement as the body. */
export function clickhouseBoundRequest(
  ctx: ConnectorContext,
  sql: string,
  rawParams: unknown,
): { url: URL; headers: Record<string, string>; body: string } | ConnectorError {
  const params = checkParams(rawParams);
  if (isParamError(params)) return params;
  const statement = cleanSql(sql);
  if (!statement) return { ok: false, error: 'No query specified' };
  const base = buildBase(ctx, 8443);
  if (isErr(base as { ok: boolean })) return base as ConnectorError;
  const url = base as URL;
  url.searchParams.set('database', str(ctx, 'database', 'default') || 'default');
  url.searchParams.set('default_format', 'JSONCompact');
  url.searchParams.set('readonly', '2');
  url.searchParams.set('max_result_rows', String(rowCap(ctx) + 1)); // +1: an exact fit is not a clip
  url.searchParams.set('result_overflow_mode', 'break');
  url.searchParams.set('max_execution_time', String(Math.max(1, Math.round(budgetMs(ctx) / 1000))));
  url.searchParams.set('cancel_http_readonly_queries_on_client_close', '1');
  for (const p of params) url.searchParams.set(`param_${p.name}`, clickhouseParamValue(p));
  const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
  headers['x-clickhouse-user'] = str(ctx, 'user', 'default') || 'default';
  const pw = secret(ctx, 'password');
  if (pw) headers['x-clickhouse-key'] = pw;
  // The compiler never writes a FORMAT clause; ours goes on its own line so a
  // trailing `--` comment in the statement cannot swallow it.
  return { url, headers, body: `${statement}\nFORMAT JSONCompact` };
}

async function clickhouseRunBound(ctx: ConnectorContext, sql: string, params: LiveParam[]): Promise<ConnectorRows | ConnectorError> {
  const req = clickhouseBoundRequest(ctx, sql, params);
  if ('ok' in req) return req;
  const r = await requestJson(ctx, { ...req, method: 'POST', timeoutMs: budgetMs(ctx), signal: ctx.signal });
  if (isErr(r)) return r;
  if (r.json === undefined) return { ok: false, error: CLIPPED };
  return shapeClickhouse(r.json, ctx, r.clipped);
}

export const CLICKHOUSE_LIVE: ConnectorLive = { dialect: 'clickhouse', runBound: clickhouseRunBound };

// ── Databricks SQL ───────────────────────────────────────────────────────────

const DATABRICKS_TYPE: Record<LiveParam['type'], string> = {
  text: 'STRING', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP',
};

/** One `parameters` entry. A NULL omits `value` — the API's own spelling of NULL. */
export function databricksParam(p: LiveParam): { name: string; type: string; value?: string } {
  const out: { name: string; type: string; value?: string } = { name: p.name, type: DATABRICKS_TYPE[p.type] };
  if (p.value !== null) out.value = String(p.value);
  return out;
}

/** The submit request: the statement, its parameters, the caps, asynchronous (`0s`). */
export function databricksBoundRequest(
  ctx: ConnectorContext,
  sql: string,
  rawParams: unknown,
): { base: URL; headers: Record<string, string>; payload: Record<string, unknown> } | ConnectorError {
  const params = checkParams(rawParams);
  if (isParamError(params)) return params;
  const statement = cleanSql(sql);
  if (!statement) return { ok: false, error: 'No query specified' };
  const base = buildBase(ctx, 443, true);
  if (isErr(base as { ok: boolean })) return base as ConnectorError;
  const warehouse = str(ctx, 'warehouseId').trim();
  if (!warehouse) return { ok: false, error: 'Warehouse ID is required' };
  const token = secret(ctx, 'token');
  if (!token) return { ok: false, error: 'Personal access token is required' };
  const payload: Record<string, unknown> = {
    statement,
    warehouse_id: warehouse,
    parameters: params.map(databricksParam),
    wait_timeout: '0s', // asynchronous: the id comes back at once, so a cancel can name it
    format: 'JSON_ARRAY',
    disposition: 'INLINE',
    row_limit: rowCap(ctx) + 1,
  };
  const catalog = str(ctx, 'catalog').trim();
  const schema = str(ctx, 'schema').trim();
  if (catalog) payload.catalog = catalog;
  if (schema) payload.schema = schema;
  return { base: base as URL, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload };
}

/** The transport `databricksRunBound` uses — a parameter so the self-check can drive the loop over https-only paths. */
export type JsonRequest = (ctx: ConnectorContext, opts: HttpRequestOptions) => Promise<JsonResult>;

const STATEMENT_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
const RUNNING = new Set(['PENDING', 'RUNNING']);
/** Poll back-off: quick first looks for the common sub-second aggregate, then once a second. */
const POLL_MS = [100, 200, 400, 800, 1_000];
/** Result chunks followed before the cap is called a clip. */
const MAX_CHUNKS = 100;

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export async function databricksRunBound(
  ctx: ConnectorContext,
  sql: string,
  params: LiveParam[],
  request: JsonRequest = requestJson,
): Promise<ConnectorRows | ConnectorError> {
  const req = databricksBoundRequest(ctx, sql, params);
  if ('ok' in req) return req;
  const deadline = Date.now() + budgetMs(ctx);
  const left = (): number => Math.max(1, deadline - Date.now());
  const at = (path: string): URL => new URL(path, req.base);
  // An abort DURING this submit cannot name the statement yet (the round trip
  // is the whole window); from the reply on, every abort POSTs its cancel.
  const submitted = await request(ctx, {
    url: at('/api/2.0/sql/statements'), method: 'POST', headers: req.headers,
    body: JSON.stringify(req.payload), timeoutMs: left(), signal: ctx.signal,
  });
  if (isErr(submitted)) return submitted;
  if (submitted.json === undefined) return { ok: false, error: CLIPPED };
  let json: unknown = submitted.json;
  const id = asString(prop(json, 'statement_id'));
  if (!STATEMENT_ID_RE.test(id)) return settled(json, ctx);
  const statement = `/api/2.0/sql/statements/${id}`;
  // Cancel, then answer. Best effort and silent: the answer is already decided.
  const stop = async (answer: ConnectorError): Promise<ConnectorError> => {
    await request(ctx, { url: at(`${statement}/cancel`), method: 'POST', headers: req.headers, body: '{}', timeoutMs: 5_000 }).catch(() => undefined);
    return answer;
  };

  for (let i = 0; RUNNING.has(asString(prop(prop(json, 'status'), 'state'))); i++) {
    if (ctx.signal?.aborted) return stop({ ok: false, error: CANCELLED });
    if (Date.now() >= deadline) return stop({ ok: false, error: timeoutError(budgetMs(ctx)).message });
    await wait(Math.min(POLL_MS[Math.min(i, POLL_MS.length - 1)], left()), ctx.signal);
    if (ctx.signal?.aborted) return stop({ ok: false, error: CANCELLED });
    const polled = await request(ctx, { url: at(statement), method: 'GET', headers: req.headers, timeoutMs: left(), signal: ctx.signal });
    if (isErr(polled)) return stop(polled);
    if (polled.json === undefined) return stop({ ok: false, error: CLIPPED });
    json = polled.json;
  }
  const first = settled(json, ctx);
  if (!first.ok) return first;
  return followChunks(ctx, request, at, statement, json, first, req.headers, left);
}

/** A finished statement's rows — or its failure. A reply with no state at all is an error, never an empty result (D6). */
function settled(json: unknown, ctx: ConnectorContext): ConnectorRows | ConnectorError {
  const state = asString(prop(prop(json, 'status'), 'state'));
  if (!state) return { ok: false, error: 'Databricks answered without a statement status.' };
  return shapeDatabricks(json, ctx);
}

/** Read `next_chunk_internal_link`s until the cap — a clip is reported, never silent. */
async function followChunks(
  ctx: ConnectorContext,
  request: JsonRequest,
  at: (path: string) => URL,
  statement: string,
  json: unknown,
  first: ConnectorRows,
  headers: Record<string, string>,
  left: () => number,
): Promise<ConnectorRows | ConnectorError> {
  const rows: Cell[][] = first.rows.slice();
  let link = asString(prop(prop(json, 'result'), 'next_chunk_internal_link'));
  for (let n = 0; link && !first.truncated && rows.length <= rowCap(ctx); n++) {
    // The link is the server's, but the host stays ours and the path stays
    // under this statement — a response body never picks where we connect.
    if (n >= MAX_CHUNKS || !link.startsWith(`${statement}/result/chunks/`) || link.includes('..')) return capRows(first.columns, rows, ctx, true);
    const chunk = await request(ctx, { url: at(link), method: 'GET', headers, timeoutMs: left(), signal: ctx.signal });
    if (isErr(chunk)) return { ok: false, error: safeError(chunk.error, ctx.secrets) };
    if (chunk.json === undefined) return { ok: false, error: CLIPPED };
    for (const row of asArray(prop(chunk.json, 'data_array'))) rows.push(asArray(row).map(toCell));
    link = asString(prop(chunk.json, 'next_chunk_internal_link'));
  }
  return capRows(first.columns, rows, ctx, first.truncated);
}

export const DATABRICKS_LIVE: ConnectorLive = {
  dialect: 'databricks',
  runBound: (ctx, sql, params) => databricksRunBound(ctx, sql, params),
};
