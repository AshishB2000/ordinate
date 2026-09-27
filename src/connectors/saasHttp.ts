// SaaS transport — MAIN PROCESS ONLY.
//
// The one way the six SaaS connectors (saas.ts) reach the network, so the three
// connector rules are enforced in one place rather than six:
//
//   • DECLARED HOSTS ONLY. Every request — and every redirect hop — is checked
//     against the connector's `hosts` list before a socket opens, and must be
//     https. Credentials only follow a redirect that stays on the same host.
//   • SECRETS STAY IN MAIN. Tokens ride in headers, never in a URL (Google's
//     Sheets API key is the one query-parameter credential, because that API
//     takes it no other way). Every error string goes out through
//     safeError(…, ctx.secrets), and a URL is never put in one.
//   • BOUNDED. ctx.timeoutMs per request (an AbortController, as url.ts does),
//     the same 100 MB body ceiling as http.ts, the API's own page-size parameter
//     on every page, and a hard page cap (MAX_PAGES) under the row cap.
//
// `fetch` is injectable (setFetch) so the self-check drives every connector off
// recorded responses with no network. The ONE runtime override is
// ORDINATE_SAAS_FIXTURE_BASE, which the smoke uses to point the declared hosts
// at a local fixture server: it is honoured only for an http://127.0.0.1:<port>
// or http://localhost:<port> origin, read at request time, and applied AFTER the
// host check — so it can redirect a declared host to loopback and nothing else.

import { MAX_BYTES } from './http';
import { safeError } from './types';
import type { ConnectorContext, ConnectorError } from './types';
import * as jobs from '../app/jobs';

// ── the fetch seam ───────────────────────────────────────────────────────────

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
const nativeFetch: FetchImpl = (url, init) => fetch(url, init);
let fetchImpl: FetchImpl = nativeFetch;

/** Route every SaaS request through `f`; null restores the real fetch. Tests only. */
export function setFetch(f: FetchImpl | null): void {
  fetchImpl = f || nativeFetch;
}

export const FIXTURE_ENV = 'ORDINATE_SAAS_FIXTURE_BASE';

/**
 * The loopback origin the smoke's fixture server listens on, or null. Anything
 * that is not exactly http + 127.0.0.1/localhost + an explicit port (no
 * credentials) is ignored, so the override can never aim a token elsewhere.
 */
export function fixtureOrigin(raw: string | undefined = process.env[FIXTURE_ENV]): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) return null;
  if (!u.port || u.username || u.password) return null;
  return u.origin;
}

/** `host` is on the list: exact, or `*.suffix` for any subdomain. */
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((d) => (d.startsWith('*.') ? h.endsWith(d.slice(1)) && h.length > d.length - 1 : h === d));
}

// ── one request ──────────────────────────────────────────────────────────────

export interface SaasRequest {
  url: URL;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

/** A failure, with the HTTP status when there was one (listTables reads 401). */
export type SaasError = ConnectorError & { status?: number };
export type SaasResponse = { ok: true; text: string } | SaasError;

const MAX_REDIRECTS = 3;

/** Wall clock for one request: ctx.timeoutMs, always finite and positive. */
function timeoutOf(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.timeoutMs);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

/** Body as text, or null past the byte ceiling (the stream is cancelled). */
async function readCapped(resp: Response): Promise<string | null> {
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** The API's own error sentence, from any of the six body shapes. */
function apiMessage(body: string): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    // An HTML error page is noise; a short plain-text body is worth showing.
    const t = body.trim();
    return t.startsWith('<') ? '' : t.slice(0, 200);
  }
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const err = o.error;
  if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    return String((err as Record<string, unknown>).message);
  }
  if (typeof o.message === 'string') return o.message;
  if (typeof err === 'string') return err;
  return '';
}

const HINT: Record<number, string> = {
  401: 'the credential was rejected',
  403: 'the credential cannot read this',
  404: 'not found — check the id or name',
  429: 'rate limited — try again in a minute',
};

/**
 * One bounded request to a declared host. Follows up to three redirects, each
 * re-checked against `hosts`; credentials are dropped on a hop to another host.
 */
export async function saasRequest(
  ctx: ConnectorContext,
  hosts: readonly string[],
  req: SaasRequest,
): Promise<SaasResponse> {
  let url = req.url;
  let headers = req.headers || {};
  const ms = timeoutOf(ctx);
  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== 'https:' || !hostAllowed(url.hostname, hosts)) {
      return { ok: false, error: `Refused: ${url.hostname || 'that address'} is not a host this source declares (${hosts.join(', ')}).` };
    }
    const fixture = fixtureOrigin();
    const target = fixture ? fixture + url.pathname + url.search : url.toString();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    let status: number;
    let text: string | null;
    try {
      const resp = await fetchImpl(target, {
        method: req.method || 'GET',
        headers: { 'user-agent': 'Ordinate', ...headers },
        body: req.body,
        signal: ctl.signal,
        redirect: 'manual',
      });
      status = resp.status;
      const location = resp.headers.get('location');
      if (status >= 300 && status < 400 && location) {
        if (hop >= MAX_REDIRECTS) return { ok: false, error: 'Too many redirects.' };
        const next = new URL(location, url);
        if (next.host !== url.host) headers = {}; // a credential never follows a hop to another host
        url = next;
        continue;
      }
      text = await readCapped(resp);
    } catch (e) {
      if (ctl.signal.aborted) return { ok: false, error: `Request timed out after ${Math.max(1, Math.round(ms / 1000))}s` };
      return { ok: false, error: safeError(e, ctx.secrets) };
    } finally {
      clearTimeout(timer);
    }
    if (text === null) return { ok: false, error: 'Response exceeded the 100 MB ceiling.' };
    if (status < 200 || status >= 300) {
      const detail = apiMessage(text);
      const hint = HINT[status] ? ` (${HINT[status]})` : '';
      return { ok: false, status, error: safeError(`HTTP ${status}${hint}${detail ? ': ' + detail : ''}`, ctx.secrets) };
    }
    return { ok: true, text };
  }
}

/** saasRequest + JSON.parse. */
export async function saasJson(
  ctx: ConnectorContext,
  hosts: readonly string[],
  req: SaasRequest,
): Promise<{ ok: true; json: unknown } | SaasError> {
  const res = await saasRequest(ctx, hosts, req);
  if (!res.ok) return res;
  try {
    return { ok: true, json: JSON.parse(res.text) as unknown };
  } catch {
    return { ok: false, error: 'The response was not valid JSON.' };
  }
}

// ── pagination ───────────────────────────────────────────────────────────────

/** Every API here caps one page at 100 records, so that is the page size asked for. */
export const PAGE_SIZE = 100;
/**
 * Pages per operation. 500 × 100 = 50,000 rows, a lower cap than the app's
 * 1,000,000 on purpose: these APIs are rate limited (Airtable 5 requests/s per
 * base, Notion ~3/s, HubSpot ~10/s, GitHub 5,000/hour), so 500 pages is already
 * two to three minutes of a refresh job — and a tenth of an hour's GitHub budget.
 */
export const MAX_PAGES = 500;

export type PageResult<T> = { ok: true; items: T[]; next: string | null } | SaasError;
/** Per item: keep it, skip it, or stop paging (a date-sorted list has passed its range). */
export type Verdict = 'keep' | 'skip' | 'stop';

/**
 * Pull pages until the cursor runs out, the row cap is reached, `keep` says
 * stop, or MAX_PAGES. `size` is the same on every request — page-number APIs
 * (GitHub) need that, and it is the API's page-size parameter every time.
 * `truncated` is true only when rows were left unread.
 */
export async function paginate<T>(
  ctx: ConnectorContext,
  fetchPage: (cursor: string | null, size: number) => Promise<PageResult<T>>,
  keep?: (item: T) => Verdict,
  maxRows = Infinity,
): Promise<{ ok: true; items: T[]; truncated: boolean } | SaasError> {
  const n = Math.floor(ctx.rowLimit);
  const cap = Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? n : 1, maxRows));
  const size = Math.min(PAGE_SIZE, cap);
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // A refresh runs as a job: honour its Cancel between pages, and say how far it got.
    const job = jobs.current();
    if (job) {
      job.checkCancelled();
      if (page > 0) job.progress(0.1, `${items.length.toLocaleString('en-US')} rows fetched`);
    }
    const res = await fetchPage(cursor, size);
    if (!res.ok) return res;
    for (const item of res.items) {
      const v = keep ? keep(item) : 'keep';
      if (v === 'stop') return { ok: true, items, truncated: false };
      if (v === 'skip') continue;
      if (items.length >= cap) return { ok: true, items, truncated: true };
      items.push(item);
    }
    if (!res.next) return { ok: true, items, truncated: false };
    if (items.length >= cap) return { ok: true, items, truncated: true };
    cursor = res.next;
  }
  return { ok: true, items, truncated: true };
}
