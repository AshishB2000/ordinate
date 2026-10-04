// URL / API JSON connector — MAIN PROCESS ONLY.
//
// This is the pre-registry `connectionRun.urlRun` moved behind the ConnectorDef
// contract, deliberately unchanged in behaviour: https ONLY, a byte ceiling, an
// AbortController timeout, the body run through parse.ts's parseJson, and the
// same user-facing error strings ('Invalid URL', 'Only https URLs are allowed',
// 'Request failed (HTTP n)', 'Empty response', 'Response too large',
// 'Could not read JSON as a table', 'Request timed out after Ns'). The one
// behaviour that MOVED rather than changed: the row cap now comes from
// ctx.rowLimit instead of parse.ts's internal MAX_ROWS, per contract rule 3.
//
// It has no tables to list, so listTables returns an empty list rather than an
// error — "this source has no table picker" is not a failure.

import { parseJson } from '../data/parse';
import type {
  ConnectorContext,
  ConnectorDef,
  ConnectorError,
  ConnectorRows,
  ConnectorTables,
} from './types';
import { safeError } from './types';
import { guardOn, safeFetch } from './ssrf';

const MAX_BYTES = 100 * 1024 * 1024; // the 100MB ceiling the URL source has always used

// Stringify a parsed cell back to the string form finalizeTable/detectColumnType
// work over. parseJson already produced these strings once (and coerced numeric
// columns); String() reverses that coercion identically for every JSON scalar.
function cellToString(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function fetchJsonRows(ctx: ConnectorContext): Promise<ConnectorRows | ConnectorError> {
  const url = str(ctx.values.url).trim();
  const token = str(ctx.secrets.token) || str(ctx.secrets.apiKey);

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

  const timeoutMs = ctx.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers['authorization'] = `Bearer ${token}`;

    // On the server the host is checked and pinned, and every redirect hop re-checked (ssrf.ts).
    const resp = await (guardOn() ? safeFetch : fetch)(parsed.toString(), { method: 'GET', headers, signal: controller.signal });
    if (!resp.ok) return { ok: false, error: `Request failed (HTTP ${resp.status})` };
    if (!resp.body) return { ok: false, error: 'Empty response' };

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
          try { await reader.cancel(); } catch (_) { /* already aborted */ }
          return { ok: false, error: 'Response too large' };
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');

    const result = parseJson(text);
    // parseJson never throws — a non-JSON / non-tabular body yields 0 columns and
    // a warning. Surface that as a friendly error rather than an empty dataset.
    if (!result.columns.length) return { ok: false, error: 'Could not read JSON as a table' };

    const truncated = result.rows.length > ctx.rowLimit;
    const rows = (truncated ? result.rows.slice(0, ctx.rowLimit) : result.rows)
      .map((row) => row.map(cellToString));
    return {
      ok: true,
      // The source has no type system of its own; report the type parse.ts
      // detected, verbatim, and let the caller re-detect as it does for a file.
      columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
      rows,
      truncated,
    };
  } catch (err: unknown) {
    // ponytail: AbortError is only identifiable by name across node/undici versions.
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
      return { ok: false, error: `Request timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    return { ok: false, error: safeError(err, ctx.secrets) };
  } finally {
    clearTimeout(timer);
  }
}

const urlConnector: ConnectorDef = {
  id: 'url',
  label: 'URL / API (JSON)',
  family: 'http',
  category: 'Files & local',
  readOnly: true,
  blurb: 'Fetch a JSON document or API endpoint over https, read-only.',
  fields: [
    {
      key: 'url',
      label: 'URL',
      type: 'text',
      required: true,
      placeholder: 'https://api.example.com/data.json',
      help: 'https only. Credentials in the URL are stripped before it is saved.',
    },
    {
      key: 'token',
      label: 'Bearer token',
      type: 'password',
      secret: true,
      help: 'Optional. Sent as an Authorization: Bearer header. Never leaves this machine.',
    },
  ],
  async listTables(_ctx: ConnectorContext): Promise<ConnectorTables | ConnectorError> {
    return { ok: true, tables: [] }; // one endpoint, no table picker
  },
  async run(ctx: ConnectorContext, _sql: string): Promise<ConnectorRows | ConnectorError> {
    return fetchJsonRows(ctx); // there is no SQL here — the URL IS the query
  },
};

export const connectors: ConnectorDef[] = [urlConnector];
export default connectors;
