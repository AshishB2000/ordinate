// SaaS request builders — MAIN PROCESS ONLY.
//
// One fetch function per API, split out of saas.ts (.claude/rules/file-size.md)
// so that file is the connector CONTRACT (resources as tables, the probe,
// describe) and this one is how each API is ASKED: its URL, its page-size
// parameter, its cursor, its date filter, and the form checks that run before
// any request. Every call goes through saasHttp.ts, which enforces the declared
// hosts, the per-request timeout, the byte ceiling and the page cap.
//
// Nothing here writes. Notion's database query and HubSpot's search are POSTs
// because that is how those APIs spell a read; no other verb is ever sent.

import { parseCsv } from '../data/parse';
import type { ConnectorContext, ConnectorError, ConnectorRows } from './types';
import { paginate, saasJson, saasRequest } from './saasHttp';
import type { PageResult, SaasError, Verdict } from './saasHttp';
import {
  airtableRows, asArray, get, githubRows, HUBSPOT_PROPS, hubspotRows, notionRows, sheetValuesRows,
  str, stripeRows,
} from './saasMap';
import type { Table } from './saasMap';

export type Result = ConnectorRows | SaasError;

// ── small helpers ────────────────────────────────────────────────────────────

function val(ctx: ConnectorContext, key: string): string {
  const v = ctx.values[key];
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}
function secret(ctx: ConnectorContext, key: string): string {
  const v = ctx.secrets[key];
  return typeof v === 'string' ? v.trim() : '';
}
export function err(error: string): ConnectorError {
  return { ok: false, error };
}
function rowCap(ctx: ConnectorContext): number {
  const n = Math.floor(ctx.rowLimit);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function rowsOf(t: Table, truncated: boolean): ConnectorRows {
  return { ok: true, columns: t.columns, rows: t.rows, truncated };
}
/** For a source with no pages (a CSV, a Sheets range): cap client-side and say so. */
function capRows(ctx: ConnectorContext, t: Table): ConnectorRows {
  const cap = rowCap(ctx);
  return rowsOf({ columns: t.columns, rows: t.rows.slice(0, cap) }, t.rows.length > cap);
}
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** From/To (YYYY-MM-DD, UTC) as epoch ms — `to` is the END of its day. */
export function dateRange(ctx: ConnectorContext): { from?: number; to?: number } | string {
  const day = (key: string, end: boolean): number | undefined => {
    const s = val(ctx, key);
    if (!s) return undefined;
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(s + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z')) : NaN;
  };
  const from = day('from', false);
  const to = day('to', true);
  if (Number.isNaN(from) || Number.isNaN(to)) return 'Dates are YYYY-MM-DD, e.g. 2024-01-31.';
  if (from !== undefined && to !== undefined && from > to) return 'The From date is after the To date.';
  return { from, to };
}

// ── Google Sheets ────────────────────────────────────────────────────────────

export const SHEETS_HOSTS = ['docs.google.com', '*.googleusercontent.com', 'sheets.googleapis.com'];

/** A "Publish to web" CSV link, or the reason it is not one. The link is the
 *  user's own text, so it is held to exactly this shape before any request. */
export function publishedCsvUrl(raw: string): URL | string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return 'That is not a link.';
  }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || !u.pathname.startsWith('/spreadsheets/') ||
      u.username || u.password) {
    return 'Only a Google Sheets link on https://docs.google.com/spreadsheets/ is accepted.';
  }
  if (u.searchParams.get('output') !== 'csv') {
    return 'Use the CSV link from File → Share → Publish to web — it ends in output=csv.';
  }
  return u;
}

/**
 * Bound a range server-side: a bare sheet name or whole columns (`A:F`) become
 * the header row plus `cap` rows. An explicit range is the user's own bound and
 * is left alone (the row cap still applies after).
 */
export function boundRange(range: string, cap: number): string {
  const bang = range.lastIndexOf('!');
  const sheet = bang < 0 ? range : range.slice(0, bang);
  const cells = bang < 0 ? '' : range.slice(bang + 1);
  const quoted = /^'.*'$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  const last = cap + 1;
  if (!cells) return `${quoted}!1:${last}`;
  const cols = /^([A-Za-z]+):([A-Za-z]+)$/.exec(cells);
  return cols ? `${quoted}!${cols[1]}1:${cols[2]}${last}` : `${quoted}!${cells}`;
}

export async function sheetsFetch(ctx: ConnectorContext): Promise<Result> {
  const csvUrl = val(ctx, 'csvUrl');
  if (csvUrl) {
    const url = publishedCsvUrl(csvUrl);
    if (typeof url === 'string') return err(url);
    // Google answers a published link with a redirect to *.googleusercontent.com,
    // which is why that host is declared; saasRequest re-checks every hop.
    const res = await saasRequest(ctx, SHEETS_HOSTS, { url, headers: { accept: 'text/csv' } });
    if (!res.ok) return res;
    const parsed = parseCsv(res.text);
    if (!parsed.columns.length) return err('The published sheet is empty.');
    // A CSV carries no types, so none are declared: the dispatch detects them
    // exactly as it does for an imported .csv file.
    return capRows(ctx, { columns: parsed.columns.map((c) => ({ name: c.name, type: 'csv' })), rows: parsed.rows });
  }
  const id = val(ctx, 'spreadsheetId');
  const key = secret(ctx, 'apiKey');
  if (!id || !key) return err('Enter a published CSV link — or a spreadsheet ID and an API key.');
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return err('The spreadsheet ID is the long code between /d/ and /edit in the sheet\'s address.');
  const range = boundRange(val(ctx, 'range') || 'Sheet1', rowCap(ctx));
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}`);
  url.searchParams.set('majorDimension', 'ROWS');
  // Numbers arrive as JSON numbers and text as strings, so the types are the sheet's own.
  url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
  url.searchParams.set('dateTimeRenderOption', 'FORMATTED_STRING');
  url.searchParams.set('key', key); // the one credential this API takes only as a query parameter
  const res = await saasJson(ctx, SHEETS_HOSTS, { url });
  if (!res.ok) return res;
  const values = asArray(get(res.json, 'values'));
  if (!values.length) return err('That range is empty.');
  return capRows(ctx, sheetValuesRows(values));
}

// ── Airtable ─────────────────────────────────────────────────────────────────

export const AIRTABLE_HOSTS = ['api.airtable.com'];

export async function airtableFetch(ctx: ConnectorContext): Promise<Result> {
  const token = secret(ctx, 'token');
  const base = val(ctx, 'baseId');
  const table = val(ctx, 'table');
  const view = val(ctx, 'view');
  if (!token) return err('A personal access token is required.');
  if (!/^app[A-Za-z0-9]{3,}$/.test(base)) return err('The base ID starts with "app" — it is the first code in the base\'s address.');
  if (!table) return err('Enter the table\'s name or ID.');
  const cap = rowCap(ctx);
  const r = await paginate<unknown>(ctx, async (cursor, size): Promise<PageResult<unknown>> => {
    const url = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', String(size));
    url.searchParams.set('maxRecords', String(cap + 1)); // +1 so a clipped table reads as truncated
    if (view) url.searchParams.set('view', view);
    if (cursor) url.searchParams.set('offset', cursor);
    const res = await saasJson(ctx, AIRTABLE_HOSTS, { url, headers: bearer(token) });
    if (!res.ok) return res;
    return { ok: true, items: asArray(get(res.json, 'records')), next: str(get(res.json, 'offset')) || null };
  });
  return r.ok ? rowsOf(airtableRows(r.items), r.truncated) : r;
}

// ── Notion ───────────────────────────────────────────────────────────────────

export const NOTION_HOSTS = ['api.notion.com'];
/** The API version whose `databases/{id}/query` shape the mapper reads. */
const NOTION_VERSION = '2022-06-28';

/** A database ID from its link or the bare ID (dashes optional): the LAST 32
 *  hex characters of the path, since the page title comes before it. */
export function notionId(raw: string): string | null {
  const p = raw.trim().split(/[?#]/)[0].replace(/\/+$/, '').replace(/-/g, '');
  const m = /([0-9a-f]{32})$/i.exec(p);
  return m ? m[1].toLowerCase() : null;
}

export async function notionFetch(ctx: ConnectorContext): Promise<Result> {
  const token = secret(ctx, 'token');
  const id = notionId(val(ctx, 'databaseId'));
  if (!token) return err('An integration secret is required.');
  if (!id) return err('The database is its link, or the 32-character ID in that link.');
  const r = await paginate<unknown>(ctx, async (cursor, size): Promise<PageResult<unknown>> => {
    const body: Record<string, unknown> = { page_size: size };
    if (cursor) body.start_cursor = cursor;
    const res = await saasJson(ctx, NOTION_HOSTS, {
      url: new URL(`https://api.notion.com/v1/databases/${id}/query`),
      method: 'POST',
      headers: { ...bearer(token), 'notion-version': NOTION_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return res;
    const more = get(res.json, 'has_more') === true;
    return { ok: true, items: asArray(get(res.json, 'results')), next: more ? str(get(res.json, 'next_cursor')) || null : null };
  });
  return r.ok ? rowsOf(notionRows(r.items), r.truncated) : r;
}

// ── Stripe ───────────────────────────────────────────────────────────────────

export const STRIPE_HOSTS = ['api.stripe.com'];

export async function stripeFetch(ctx: ConnectorContext, resource: string): Promise<Result> {
  const key = secret(ctx, 'apiKey');
  if (!key) return err('A restricted key is required.');
  // A secret key (sk_) can move money. This app only reads, so it only takes
  // the key that can be limited to reading.
  if (!key.startsWith('rk_')) return err('Use a restricted key (rk_…) with Read access. A secret key can also write, and this app never needs to.');
  const range = dateRange(ctx);
  if (typeof range === 'string') return err(range);
  const r = await paginate<unknown>(ctx, async (cursor, size): Promise<PageResult<unknown>> => {
    const url = new URL(`https://api.stripe.com/v1/${resource}`);
    url.searchParams.set('limit', String(size));
    if (resource === 'subscriptions') url.searchParams.set('status', 'all'); // the default hides canceled ones
    if (range.from !== undefined) url.searchParams.set('created[gte]', String(Math.floor(range.from / 1000)));
    if (range.to !== undefined) url.searchParams.set('created[lte]', String(Math.floor(range.to / 1000)));
    if (cursor) url.searchParams.set('starting_after', cursor);
    const res = await saasJson(ctx, STRIPE_HOSTS, { url, headers: bearer(key) });
    if (!res.ok) return res;
    const data = asArray(get(res.json, 'data'));
    const last = str(get(data[data.length - 1], 'id'));
    return { ok: true, items: data, next: get(res.json, 'has_more') === true && last ? last : null };
  });
  return r.ok ? rowsOf(stripeRows(r.items), r.truncated) : r;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

export const GITHUB_HOSTS = ['api.github.com'];

/** `owner/name` from what was typed (a github.com link is accepted), or null. */
export function githubRepo(raw: string): string | null {
  const s = raw.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(s) ? s : null;
}

export async function githubFetch(ctx: ConnectorContext, resource: string): Promise<Result> {
  const token = secret(ctx, 'token');
  const repo = githubRepo(val(ctx, 'repo'));
  if (!token) return err('A personal access token is required.');
  if (!repo) return err('The repository is owner/name, e.g. octocat/hello-world.');
  const range = dateRange(ctx);
  if (typeof range === 'string') return err(range);
  const headers = { ...bearer(token), accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  // Issues and pulls are asked for NEWEST-CREATED first, so the first one older
  // than `from` ends the walk; for issues `since` also lets the server skip
  // anything untouched since then. Commits have real since/until filters.
  const keep = resource === 'commits' ? undefined : (o: unknown): Verdict => {
    if (resource === 'issues' && get(o, 'pull_request') !== undefined) return 'skip'; // this endpoint lists PRs too
    const t = Date.parse(str(get(o, 'created_at')));
    if (range.to !== undefined && t > range.to) return 'skip';
    if (range.from !== undefined && t < range.from) return 'stop';
    return 'keep';
  };
  const r = await paginate<unknown>(ctx, async (cursor, size): Promise<PageResult<unknown>> => {
    const page = Number(cursor || '1');
    const url = new URL(`https://api.github.com/repos/${repo}/${resource}`);
    url.searchParams.set('per_page', String(size));
    url.searchParams.set('page', String(page));
    if (resource === 'commits') {
      if (range.from !== undefined) url.searchParams.set('since', new Date(range.from).toISOString());
      if (range.to !== undefined) url.searchParams.set('until', new Date(range.to).toISOString());
    } else {
      url.searchParams.set('state', 'all');
      url.searchParams.set('sort', 'created');
      url.searchParams.set('direction', 'desc');
      if (resource === 'issues' && range.from !== undefined) url.searchParams.set('since', new Date(range.from).toISOString());
    }
    const res = await saasJson(ctx, GITHUB_HOSTS, { url, headers });
    if (!res.ok) return res;
    const items = asArray(res.json);
    return { ok: true, items, next: items.length >= size ? String(page + 1) : null };
  }, keep);
  return r.ok ? rowsOf(githubRows(resource, r.items), r.truncated) : r;
}

// ── HubSpot ──────────────────────────────────────────────────────────────────

export const HUBSPOT_HOSTS = ['api.hubapi.com'];
/** HubSpot's search endpoint answers at most 10,000 records per query. */
const HUBSPOT_SEARCH_MAX = 10_000;

export async function hubspotFetch(ctx: ConnectorContext, object: string): Promise<Result> {
  const token = secret(ctx, 'token');
  if (!token) return err('A private app access token is required.');
  const range = dateRange(ctx);
  if (typeof range === 'string') return err(range);
  const props = (HUBSPOT_PROPS[object] || []).map(([p]) => p);
  // A date range needs the search endpoint (the list endpoint has no filter);
  // without one the list endpoint has no 10,000 ceiling.
  const search = range.from !== undefined || range.to !== undefined;
  const r = await paginate<unknown>(ctx, async (cursor, size): Promise<PageResult<unknown>> => {
    let res;
    if (search) {
      const filters: Array<Record<string, string>> = [];
      if (range.from !== undefined) filters.push({ propertyName: 'createdate', operator: 'GTE', value: String(range.from) });
      if (range.to !== undefined) filters.push({ propertyName: 'createdate', operator: 'LTE', value: String(range.to) });
      const body: Record<string, unknown> = {
        limit: size,
        properties: props,
        filterGroups: [{ filters }],
        sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
      };
      if (cursor) body.after = cursor;
      res = await saasJson(ctx, HUBSPOT_HOSTS, {
        url: new URL(`https://api.hubapi.com/crm/v3/objects/${object}/search`),
        method: 'POST',
        headers: { ...bearer(token), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      const url = new URL(`https://api.hubapi.com/crm/v3/objects/${object}`);
      url.searchParams.set('limit', String(size));
      url.searchParams.set('properties', props.join(','));
      url.searchParams.set('archived', 'false');
      if (cursor) url.searchParams.set('after', cursor);
      res = await saasJson(ctx, HUBSPOT_HOSTS, { url, headers: bearer(token) });
    }
    if (!res.ok) return res;
    return { ok: true, items: asArray(get(res.json, 'results')), next: str(get(res.json, 'paging', 'next', 'after')) || null };
  }, undefined, search ? HUBSPOT_SEARCH_MAX : Infinity);
  return r.ok ? rowsOf(hubspotRows(object, r.items), r.truncated) : r;
}
