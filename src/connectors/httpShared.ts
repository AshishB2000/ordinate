// The HTTP query engines' shared plumbing — MAIN PROCESS ONLY.
//
// Split out of http.ts (pinned at its file-size cap) so the Live capability
// (liveHttp.ts, docs/live-data/00-plan.md L2.1) can run a bound statement on
// the same transport without growing it. One job: what EVERY engine request
// goes through — the bounded transport (wall clock, byte ceiling, SSRF pin,
// abort), JSON parsing with secret redaction, the typed accessors over a
// ConnectorContext, the base URL, the client-side row cap, and the Databricks
// response shape both `run` and `runBound` read. The engines' own request and
// response shaping stays in http.ts; http.ts re-exports what its callers and
// its self-check already import from it.
//
// Nothing here logs a request body or an Authorization header, and every error
// goes out through safeError(e, ctx.secrets) — see the http.ts header.

import * as http from 'http';
import * as https from 'https';
import { ConnectorColumn, ConnectorContext, ConnectorError, ConnectorRows, safeError } from './types';
import { checkHost, guardOn, pinnedLookup, type PinnedHost } from './ssrf';

/** Response byte ceiling — the same constant connectionRun.ts's urlRun uses. */
export const MAX_BYTES = 100 * 1024 * 1024;

export type Cell = string | number | boolean | null;

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
  /** The caller gave up (Live: the client hung up). The socket is destroyed, like the wall clock. */
  signal?: AbortSignal;
}

export interface HttpResult {
  status: number;
  body: string;
  /** True when the byte ceiling clipped the body. */
  truncated: boolean;
}

/** One bounded HTTP request. Exported so the self-check can drive the transport
 *  directly against a stub server (byte cap, timeout, socket destruction). On the
 *  server every request (Trino's nextUri pages too) is checked and pinned (ssrf.ts);
 *  no redirect is ever followed. */
export async function httpRequest(opts: HttpRequestOptions): Promise<HttpResult> {
  const pin = guardOn() ? await checkHost(opts.url.hostname) : null;
  return send(opts, pin);
}

function send(opts: HttpRequestOptions, pin: PinnedHost | null): Promise<HttpResult> {
  const maxBytes = opts.maxBytes === undefined ? MAX_BYTES : opts.maxBytes;
  return new Promise<HttpResult>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      req.destroy(abortError());
    };
    const done = (err: Error | null, value?: HttpResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err) reject(timedOut ? timeoutError(opts.timeoutMs) : err);
      else resolve(value as HttpResult);
    };
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }

    let req: http.ClientRequest;
    try {
      const mod = opts.url.protocol === 'https:' ? https : http;
      req = mod.request(opts.url, {
        method: opts.method,
        headers: { 'user-agent': 'Ordinate', ...(opts.headers || {}) },
        ...(pin ? { lookup: pinnedLookup(pin), agent: false } : {}), // agent:false: a pooled socket is not keyed by the pin
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
    // Same teardown on abort: a destroyed socket is what makes ClickHouse stop a
    // read-only query (cancel_http_readonly_queries_on_client_close).
    opts.signal?.addEventListener('abort', onAbort, { once: true });

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

export function timeoutError(ms: number): Error {
  return new Error(`Request timed out after ${Math.max(1, Math.round(ms / 1000))}s`);
}

/** The message a cancelled request ends with — the same one on every live path. */
export const CANCELLED = 'Cancelled';

function abortError(): Error {
  return new Error(CANCELLED);
}

// A parsed JSON response. `json` is undefined only when the byte cap clipped the
// body mid-document — the caller then reports truncation instead of guessing.
export type JsonResult = { ok: true; json: unknown; clipped: boolean } | ConnectorError;

export async function requestJson(
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

export function prop(o: unknown, key: string): unknown {
  if (o !== null && typeof o === 'object') return (o as Record<string, unknown>)[key];
  return undefined;
}
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v as Cell;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
export function str(ctx: ConnectorContext, key: string, fallback = ''): string {
  const v = ctx.values[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}
export function num(ctx: ConnectorContext, key: string, fallback: number): number {
  const v = ctx.values[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
export function bool(ctx: ConnectorContext, key: string): boolean {
  const v = ctx.values[key];
  return v === true || v === 'true' || v === 1 || v === '1';
}
export function secret(ctx: ConnectorContext, key: string): string {
  const v = ctx.secrets[key];
  return typeof v === 'string' ? v : '';
}
/** Row cap: always at least 1, always finite. */
export function rowCap(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.rowLimit);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
/** Wall clock for one operation: always at least 1s, always finite. */
export function budgetMs(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.timeoutMs);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}
/** Trailing `;` breaks Trino/Presto/Druid/ES/OpenSearch. Strip it everywhere. */
export function cleanSql(sql: string): string {
  return String(sql || '').trim().replace(/;\s*$/, '');
}
export function basicAuth(user: string, password: string): string {
  return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
}
export function isErr(v: { ok: boolean }): v is ConnectorError {
  return v.ok === false;
}

/** Build the origin URL from the form values.
 *  https unless `insecureHttp` is explicitly ticked; a pasted `http://` host is
 *  REJECTED rather than silently honoured, so TLS can never be lost by accident. */
export function buildBase(
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

/** Cap rows and report it. The one place rowLimit is applied client-side. */
export function capRows(columns: ConnectorColumn[], rows: Cell[][], ctx: ConnectorContext, already = false): ConnectorRows {
  const cap = rowCap(ctx);
  const truncated = already || rows.length > cap;
  return { ok: true, columns, rows: rows.length > cap ? rows.slice(0, cap) : rows, truncated };
}

export const CLIPPED = 'Response exceeded the 100 MB ceiling and was cut off — narrow the query or lower the row limit.';

/** A ClickHouse `FORMAT JSONCompact` body → ConnectorRows: `run` and `runBound` read the same shape. */
export function shapeClickhouse(json: unknown, ctx: ConnectorContext, clipped = false): ConnectorRows {
  const columns: ConnectorColumn[] = asArray(prop(json, 'meta')).map((m) => ({
    name: asString(prop(m, 'name')),
    type: asString(prop(m, 'type')) || 'unknown',
  }));
  const rows: Cell[][] = asArray(prop(json, 'data')).map((row) => asArray(row).map(toCell));
  return capRows(columns, rows, ctx, clipped);
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
