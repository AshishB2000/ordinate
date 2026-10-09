// BigQuery sign-in — MAIN PROCESS ONLY. A service-account key (the JSON file
// Google issues) becomes a short-lived OAuth access token: an RS256 JWT signed
// with the key (./jwt.ts) is exchanged at Google's token endpoint (RFC 7523,
// the jwt-bearer grant). No dependency, and the key never leaves this process:
// only the signature does.
//
// THE KEY FILE IS USER INPUT (threat R-L3). Its `token_uri` names where a
// client should send the signed assertion; honouring a free-form one would let
// a crafted key file aim the assertion — a bearer credential for an hour — and
// the server's own egress at any host. So `token_uri` must equal TOKEN_URI
// character for character or the key is refused, and the exchange is sent to
// the constant anyway, never to the file's field. `type` must be
// `service_account`; `client_email` and an RSA `private_key` must be present.
// Every refusal is a fixed sentence: a key's text (or JSON.parse's message,
// which quotes the input) never reaches an error.
//
// SCOPES. Queries, results and the catalog run under a READ-ONLY token
// (bigquery.readonly, plus cloud-platform.read-only, the read-only scope
// Google's own discovery document lists for jobs.query today). Whether Google
// enforces read-only for jobs.query under those scopes is UNVERIFIED (no
// account to run the plan's spike — docs/live-data/log.md), so bigquery.ts
// also dry-runs every user statement and refuses anything but a SELECT.
// jobs.cancel is the one call no read-only scope covers; it gets its own
// token with the `bigquery` scope, used for that URL and nothing else.
//
// CACHE. A token lives ~55 min, per key and scope, under orgKey() (record ids
// and keys repeat across orgs after an import; T0.3). A cold cache shares one
// in-flight exchange between concurrent queries.

import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { loadPrivateKey, signJwtRs256 } from './jwt';
import { orgKey } from '../server/context';
import type { ConnectorError } from './types';

export const TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const TOKEN_HOST = 'oauth2.googleapis.com';
export const READ_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/bigquery.readonly',
  'https://www.googleapis.com/auth/cloud-platform.read-only',
];
export const CANCEL_SCOPES: readonly string[] = ['https://www.googleapis.com/auth/bigquery'];

/** A token is reused for at most this long (Google issues them for 60 min). */
const TOKEN_TTL_MS = 55 * 60_000;
const MAX_CACHED = 500;

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: KeyObject;
  privateKeyId?: string;
  projectId?: string;
  /** sha256 of the key file's text: the cache key, so the key itself is never one. */
  fingerprint: string;
  /** Every string an error must never contain: the file, the PEM and its lines, the key id. */
  scrub: string[];
}

const bad = (error: string): ConnectorError => ({ ok: false, error });

/** The key file → a usable key, or a fixed refusal that quotes nothing from the file. */
export function parseKey(raw: string): ServiceAccountKey | ConnectorError {
  const textIn = String(raw ?? '').trim();
  if (!textIn) return bad('Paste the service-account key (the JSON file from Google Cloud IAM).');
  let json: unknown;
  try {
    json = JSON.parse(textIn) as unknown;
  } catch {
    return bad('The service-account key is not valid JSON. Paste the whole key file.');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return bad('The service-account key is not a JSON object.');
  const k = json as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (str(k.type) !== 'service_account') return bad('This is not a service-account key ("type" must be "service_account").');
  if (str(k.token_uri) !== TOKEN_URI) {
    return bad(`Refused: the key's token_uri must be exactly ${TOKEN_URI}. This server sends a signed key assertion to Google and nowhere else.`);
  }
  if (k.universe_domain !== undefined && k.universe_domain !== 'googleapis.com') {
    return bad('Refused: only keys for the googleapis.com universe are supported.');
  }
  const clientEmail = str(k.client_email);
  if (!/^[^\s@]{1,128}@[^\s@]{1,253}$/.test(clientEmail)) return bad('The service-account key has no client_email.');
  const pem = str(k.private_key);
  const privateKey = loadPrivateKey(pem);
  if (!privateKey) return bad('The service-account key has no usable RSA private_key.');
  const privateKeyId = str(k.private_key_id);
  const projectId = str(k.project_id);
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const scrub = [textIn, pem, pem.trim(), body, ...pem.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 16 && !l.startsWith('-----'))];
  if (privateKeyId) scrub.push(privateKeyId);
  const out: ServiceAccountKey = {
    clientEmail,
    privateKey,
    fingerprint: createHash('sha256').update(textIn).digest('hex'),
    scrub,
  };
  if (privateKeyId) out.privateKeyId = privateKeyId;
  if (projectId) out.projectId = projectId;
  return out;
}

/** The assertion's claims (RFC 7523 §3): one hour, Google's token endpoint as the audience. */
export function jwtClaims(key: Pick<ServiceAccountKey, 'clientEmail'>, scopes: readonly string[], nowSec: number): Record<string, unknown> {
  return { iss: key.clientEmail, scope: scopes.join(' '), aud: TOKEN_URI, iat: nowSec, exp: nowSec + 3600 };
}

/** The signed assertion. `kid` names the key so Google need not try each of the account's keys. */
export function signAssertion(key: ServiceAccountKey, scopes: readonly string[], nowSec: number): string {
  return signJwtRs256(jwtClaims(key, scopes, nowSec), key.privateKey, key.privateKeyId ? { kid: key.privateKeyId } : {});
}

/** The exchange request: always the constant TOKEN_URI, form-encoded. */
export function tokenRequest(assertion: string): { url: URL; headers: Record<string, string>; body: string } {
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
  return { url: new URL(TOKEN_URI), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body };
}

/** Google's reply → the token and its lifetime, or Google's own refusal (no secret in either). */
export function readTokenReply(status: number, body: string): { ok: true; token: string; expiresInSec: number } | ConnectorError {
  let json: Record<string, unknown> = {};
  try {
    const v = JSON.parse(body) as unknown;
    if (v && typeof v === 'object') json = v as Record<string, unknown>;
  } catch {
    /* an HTML error page — reported by status below */
  }
  const token = typeof json.access_token === 'string' ? json.access_token : '';
  if (status >= 200 && status < 300 && token) {
    const n = Number(json.expires_in);
    return { ok: true, token, expiresInSec: Number.isFinite(n) && n > 0 ? n : 3600 };
  }
  const code = typeof json.error === 'string' ? json.error.slice(0, 80) : '';
  const why = typeof json.error_description === 'string' ? json.error_description.slice(0, 200) : '';
  return bad(`Google refused the service-account key${code ? `: ${code}` : ` (HTTP ${status})`}${why ? ` — ${why}` : ''}`);
}

// ── the cache ───────────────────────────────────────────────────────────────

type Exchange = (assertion: string) => Promise<{ ok: true; token: string; expiresInSec: number } | ConnectorError>;

const tokens = new Map<string, { token: string; until: number }>();
const inflight = new Map<string, Promise<{ ok: true; token: string } | ConnectorError>>();

function cacheKey(key: ServiceAccountKey, scopes: readonly string[]): string | null {
  try {
    return orgKey(`bigquery\u0000${key.fingerprint}\u0000${scopes.join(' ')}`);
  } catch {
    return null; // outside a request on the server: no org to file it under, so no caching
  }
}

/**
 * An access token for `key` with `scopes`: from the cache, or one exchange
 * (shared by concurrent callers). `exchange` sends the signed assertion — it
 * is bigquery.ts's guarded transport, so the token request is SSRF-checked too.
 */
export async function accessToken(key: ServiceAccountKey, scopes: readonly string[], exchange: Exchange): Promise<{ ok: true; token: string } | ConnectorError> {
  const ck = cacheKey(key, scopes);
  const now = Date.now();
  if (ck) {
    const hit = tokens.get(ck);
    if (hit && hit.until > now) return { ok: true, token: hit.token };
    if (hit) tokens.delete(ck);
    const pending = inflight.get(ck);
    if (pending) return pending;
  }
  const run = (async (): Promise<{ ok: true; token: string } | ConnectorError> => {
    const r = await exchange(signAssertion(key, scopes, Math.floor(now / 1000)));
    if (!r.ok) return r;
    if (ck) {
      if (tokens.size >= MAX_CACHED) tokens.delete(tokens.keys().next().value as string);
      tokens.set(ck, { token: r.token, until: now + Math.min(TOKEN_TTL_MS, (r.expiresInSec - 60) * 1000) });
    }
    return { ok: true, token: r.token };
  })();
  if (!ck) return run;
  inflight.set(ck, run);
  try {
    return await run;
  } finally {
    inflight.delete(ck);
  }
}

/** Forget every cached token. Tests only. */
export function clearTokens(): void {
  tokens.clear();
  inflight.clear();
}
