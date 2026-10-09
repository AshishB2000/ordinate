// The fake transport the BigQuery self-checks inject (bigquery.setTransport),
// the recorded REST replies under scripts/fixtures/bigquery/, and a
// service-account key minted per run (a private key is never committed, even a
// test one). No network: a route answers each request, and every request is
// recorded so a suite can assert what was ASKED — the SQL text, the
// parameters, the cost guard, which token went where.
//
// Not a suite itself — test-connectorsBigquery.ts and test-bigqueryBounds.ts import it.

import { generateKeyPairSync, type KeyObject } from 'crypto';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type HttpRequestOptions = import('../src/connectors/http').HttpRequestOptions;
type HttpResult = import('../src/connectors/http').HttpResult;
type ConnectorContext = import('../src/connectors/types').ConnectorContext;

export const PROJECT = 'acme-analytics';
export const TOKEN_URI = 'https://oauth2.googleapis.com/token';

export interface Call {
  url: URL;
  method: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
  /** The JSON body, when it is one. */
  json: any; // any: a recorded request body, read field by field
  timeoutMs: number;
  at: number;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  /** Answer after this many ms (a slow job). */
  delayMs?: number;
  /** Never answer before the request's own timeout (a hung server). */
  hang?: boolean;
}

export function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'bigquery', name), 'utf8')) as unknown;
}

export function fakeTransport(route: (c: Call) => Reply): { transport: (o: HttpRequestOptions) => Promise<HttpResult>; calls: Call[] } {
  const calls: Call[] = [];
  const transport = async (o: HttpRequestOptions): Promise<HttpResult> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.headers || {})) headers[k.toLowerCase()] = String(v);
    let json: unknown;
    try { json = o.body ? JSON.parse(o.body) : undefined; } catch { json = undefined; }
    const call: Call = { url: o.url, method: o.method, headers, body: o.body ?? '', json, timeoutMs: o.timeoutMs, at: Date.now() };
    calls.push(call);
    const r = route(call);
    const reply: HttpResult = { status: r.status ?? 200, body: r.text ?? JSON.stringify(r.json ?? {}), truncated: false };
    if (r.hang) {
      return new Promise((_res, reject) => setTimeout(() => reject(new Error(`Request timed out after ${Math.max(1, Math.round(o.timeoutMs / 1000))}s`)), Math.min(o.timeoutMs, 3_000)));
    }
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    return reply;
  };
  return { transport, calls };
}

export interface Key {
  /** The key file's text, as pasted. */
  json: string;
  pem: string;
  publicKey: KeyObject;
  privateKeyId: string;
}

/** A service-account key file shaped like Google's, with a fresh RSA key. */
export function makeKey(overrides: Record<string, unknown> = {}): Key {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const privateKeyId = 'f3b1c0ffee' + Math.random().toString(16).slice(2, 12).padEnd(10, '0') + 'a1b2c3d4e5f6a7b8c9d0';
  const obj = {
    type: 'service_account',
    project_id: PROJECT,
    private_key_id: privateKeyId,
    private_key: pem,
    client_email: `ordinate-reader@${PROJECT}.iam.gserviceaccount.com`,
    client_id: '104467319843519027654',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: TOKEN_URI,
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/ordinate-reader%40${PROJECT}.iam.gserviceaccount.com`,
    universe_domain: 'googleapis.com',
    ...overrides,
  };
  return { json: JSON.stringify(obj, null, 2), pem, publicKey, privateKeyId };
}

/** A token exchange's assertion, its claims and header decoded (no verification). */
export function assertionOf(c: Call): { assertion: string; header: Record<string, unknown>; claims: Record<string, unknown> } {
  const assertion = new URLSearchParams(c.body).get('assertion') || '';
  const [h, p] = assertion.split('.');
  const dec = (s: string): Record<string, unknown> => JSON.parse(Buffer.from(s || '', 'base64url').toString('utf8') || '{}') as Record<string, unknown>;
  return { assertion, header: dec(h), claims: dec(p) };
}

export const isToken = (c: Call): boolean => c.url.hostname === 'oauth2.googleapis.com';
export const isDry = (c: Call): boolean => c.url.pathname.endsWith('/queries') && c.method === 'POST' && c.json?.dryRun === true;
export const isQuery = (c: Call): boolean => c.url.pathname.endsWith('/queries') && c.method === 'POST' && c.json?.dryRun !== true;
export const isResults = (c: Call): boolean => c.method === 'GET' && /\/queries\/[^/]+$/.test(c.url.pathname);
export const isCancel = (c: Call): boolean => c.method === 'POST' && c.url.pathname.endsWith('/cancel');

/**
 * The usual answers: a token per scope (`ya29.read-N` / `ya29.cancel-N`, so a
 * suite can tell which token a request carried), a SELECT dry run, a finished
 * query with every column type, a cancel acknowledged. `extra` answers first.
 */
export function happy(extra?: (c: Call) => Reply | null): (c: Call) => Reply {
  let n = 0;
  return (c) => {
    const x = extra ? extra(c) : null;
    if (x) return x;
    if (isToken(c)) {
      n += 1;
      const scope = String(assertionOf(c).claims.scope || '');
      const kind = scope === 'https://www.googleapis.com/auth/bigquery' ? 'cancel' : 'read';
      return { json: { access_token: `ya29.${kind}-${n}`, expires_in: 3599, token_type: 'Bearer' } };
    }
    if (isDry(c)) return { json: fixture('dryrun-select.json') };
    if (isQuery(c)) return { json: fixture('query-types.json') };
    if (isCancel(c)) return { json: { kind: 'bigquery#jobCancelResponse', job: { status: { state: 'DONE' } } } };
    return { status: 404, json: { error: { code: 404, message: `Not found: ${c.url.pathname}`, status: 'NOT_FOUND' } } };
  };
}

export function ctxFor(key: Key, values: Record<string, unknown> = {}, extra: Partial<ConnectorContext> = {}): ConnectorContext {
  return { values: { project: PROJECT, location: 'europe-west2', ...values }, secrets: { token: key.json }, rowLimit: 1000, timeoutMs: 5_000, ...extra };
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
