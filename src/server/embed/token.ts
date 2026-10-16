// Embed tokens (docs/embed/00-design.md) — PURE: no I/O, no clock but `now`.
//
// A token is a JWT in compact form, HS256 only, signed by the host app's
// BACKEND with its org's embed secret:
//
//   base64url({"alg":"HS256","typ":"JWT","kid":"<org>"}) . base64url(claims) . base64url(HMAC-SHA256)
//
// verify() is split so the caller can fetch the org's secret between the two
// halves: `readHeader` trusts nothing but the header's SHAPE (the org it
// names is only a lookup key), `verifyToken` checks the MAC with
// timingSafeEqual and only THEN parses the claims. Every claim is checked and
// an unknown one refuses the token — a misspelt `params` must never yield an
// unscoped dashboard.

import { createHmac, timingSafeEqual } from 'crypto';
import { ORG_RE } from '../../app/paths';

/** At most this far ahead may a token expire (the host signs short-lived tokens). */
export const MAX_TTL_SEC = 24 * 60 * 60;
/** A preview token (Admin / the Embed dialog) lives this long at most. */
export const PREVIEW_TTL_SEC = 10 * 60;
/** Clock skew allowed between the host and this server. */
const SKEW_SEC = 60;
const MAX_TOKEN = 8 * 1024;
export const MAX_LOCK_COLUMNS = 8;
export const MAX_LOCK_VALUES = 100;
const MAX_VALUE_LEN = 200;
const MAX_COLUMN_LEN = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const HIDE = ['title', 'filters'] as const;
const CLAIMS = new Set(['pub', 'dash', 'exp', 'iat', 'params', 'theme', 'hide', 'prv']);

export type Hide = (typeof HIDE)[number];
export type LockValue = string | number;

export interface EmbedClaims {
  /** The published link's id (src/publish/hosted.ts). */
  readonly pub: string;
  /** Which dashboard of the link; absent = its first. */
  readonly dash?: string;
  readonly exp: number;
  readonly iat?: number;
  /** Locked filters: column → the values it is held to (1..MAX_LOCK_VALUES). */
  readonly params: Readonly<Record<string, readonly LockValue[]>>;
  readonly theme?: 'light' | 'dark';
  readonly hide: readonly Hide[];
  /** A preview token, signed by the server itself: a same-origin iframe only. */
  readonly prv?: true;
}

/** Why a token was refused. `bad` = we cannot even trust which org it names. */
export type TokenRefusal = 'bad' | 'signature' | 'expired' | 'exp_too_far' | 'claims';

export type Verified = { ok: true; claims: EmbedClaims } | { ok: false; reason: TokenRefusal };

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

function mac(secret: string, signingInput: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(signingInput, 'utf8').digest();
}

/** The org a token names, if its header is exactly an HS256 JWT header — else null. Trusts nothing else. */
export function readHeader(token: unknown): { org: string } | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return null;
  let h: unknown;
  try {
    h = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  const o = h as Record<string, unknown>;
  // Exactly these keys: an `alg` other than HS256 (none, HS512, RS256 — algorithm confusion), a `jku`/`jwk`/`crit`, refused.
  if (Object.keys(o).some((k) => k !== 'alg' && k !== 'typ' && k !== 'kid')) return null;
  if (o.alg !== 'HS256' || (o.typ !== undefined && o.typ !== 'JWT')) return null;
  return typeof o.kid === 'string' && ORG_RE.test(o.kid) ? { org: o.kid } : null;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function lockValues(v: unknown): LockValue[] | null {
  const list = Array.isArray(v) ? v : [v];
  if (list.length < 1 || list.length > MAX_LOCK_VALUES) return null;
  const out: LockValue[] = [];
  for (const x of list) {
    // `[[name]]` is a dashboard parameter reference (analysis/params.ts): a lock value is a literal, never bound to one.
    if (typeof x === 'string' && x.length <= MAX_VALUE_LEN && !x.includes('[[')) out.push(x);
    else if (typeof x === 'number' && Number.isFinite(x)) out.push(x);
    else return null;
  }
  return out;
}

/** The claims, every one checked; a refusal when any is missing, unknown or out of range. */
export function parseClaims(raw: unknown, now: number): EmbedClaims | TokenRefusal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'claims';
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !CLAIMS.has(k))) return 'claims';
  if (typeof o.pub !== 'string' || !UUID_RE.test(o.pub)) return 'claims';
  if (o.dash !== undefined && (typeof o.dash !== 'string' || !UUID_RE.test(o.dash))) return 'claims';
  if (typeof o.exp !== 'number' || !Number.isFinite(o.exp)) return 'claims';
  if (o.iat !== undefined && (typeof o.iat !== 'number' || !Number.isFinite(o.iat) || o.iat > now + SKEW_SEC)) return 'claims';
  if (o.prv !== undefined && o.prv !== 1 && o.prv !== true) return 'claims';
  if (o.theme !== undefined && o.theme !== 'light' && o.theme !== 'dark') return 'claims';
  const hide: Hide[] = [];
  if (o.hide !== undefined) {
    if (!Array.isArray(o.hide) || o.hide.length > HIDE.length) return 'claims';
    for (const x of o.hide) {
      if (!(HIDE as readonly unknown[]).includes(x)) return 'claims';
      if (!hide.includes(x as Hide)) hide.push(x as Hide);
    }
  }
  const params: Record<string, LockValue[]> = {};
  if (o.params !== undefined) {
    if (!o.params || typeof o.params !== 'object' || Array.isArray(o.params)) return 'claims';
    const cols = Object.keys(o.params);
    if (cols.length > MAX_LOCK_COLUMNS) return 'claims';
    for (const col of cols) {
      if (!col || col.length > MAX_COLUMN_LEN || !own(o.params, col)) return 'claims';
      const vals = lockValues((o.params as Record<string, unknown>)[col]);
      if (!vals) return 'claims'; // empty, too many, or not a string / finite number: never a widened filter
      params[col] = vals;
    }
  }
  if (o.exp < now - SKEW_SEC) return 'expired';
  const ttl = o.prv !== undefined ? PREVIEW_TTL_SEC : MAX_TTL_SEC;
  if (o.exp > now + ttl + SKEW_SEC) return 'exp_too_far';
  return {
    pub: o.pub,
    ...(o.dash ? { dash: o.dash as string } : {}),
    exp: o.exp,
    ...(o.iat !== undefined ? { iat: o.iat as number } : {}),
    params,
    ...(o.theme ? { theme: o.theme as 'light' | 'dark' } : {}),
    hide,
    ...(o.prv !== undefined ? { prv: true as const } : {}),
  };
}

/**
 * Check `token` against `secret` (the org `readHeader` named). The MAC is
 * compared in constant time BEFORE the payload is decoded; `now` is seconds.
 */
export function verifyToken(token: string, secret: string, now: number): Verified {
  if (!readHeader(token)) return { ok: false, reason: 'bad' };
  const [h, p, s] = token.split('.');
  const given = Buffer.from(s, 'base64url');
  const want = mac(secret, `${h}.${p}`);
  // Canonical encoding only, so one MAC has one spelling (the rate limit keys on it).
  if (given.length !== want.length || b64(given) !== s || !timingSafeEqual(given, want)) return { ok: false, reason: 'signature' };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'claims' };
  }
  const claims = parseClaims(raw, now);
  return typeof claims === 'string' ? { ok: false, reason: claims } : { ok: true, claims };
}

/** Sign `payload` for `org` — the server's own preview tokens, and the tests. The host's backend does the same (the snippets). */
export function signToken(org: string, payload: Record<string, unknown>, secret: string): string {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: org }));
  const p = b64(JSON.stringify(payload));
  return `${h}.${p}.${mac(secret, `${h}.${p}`).toString('base64url')}`;
}

/** A short public fingerprint of a token (its MAC), for rate-limit keys and logs — never the token. */
export function tokenFingerprint(token: string): string {
  const s = token.split('.')[2] ?? '';
  return s.slice(0, 16);
}
