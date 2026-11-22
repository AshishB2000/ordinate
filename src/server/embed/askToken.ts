// The Assistant's embed token (docs/embedded-assistant/00-design.md): the host's backend signs it with the org's embed
// secret, like a dashboard token, but its claims are its own closed set. PURE: no I/O, no clock but `now`.
//
//   agent   uuid of the Assistant agent
//   sub     the customer's own user id (data: never logged)
//   params  locked filters, column → 1..100 literal values
//   exp/iat seconds; exp at most 1 hour ahead
//
// `pub`, `dash`, `prv`, `theme`, `hide` and any unknown claim refuse, so a dashboard token never verifies here, and
// (the dashboard parser requires `pub` and refuses `agent`) an Assistant token never verifies there.

import { MAX_LOCK_COLUMNS, lockValues, verifyMac, type LockValue, type TokenRefusal } from './token';

export const ASK_MAX_TTL_SEC = 60 * 60;
const SKEW_SEC = 60;
const MAX_SUB = 200;
const MAX_COLUMN_LEN = 200;
const CLAIMS = new Set(['agent', 'sub', 'params', 'exp', 'iat']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AskClaims {
  readonly agent: string;
  readonly sub: string;
  readonly params: Readonly<Record<string, readonly LockValue[]>>;
  readonly exp: number;
}

export type AskVerified = { ok: true; claims: AskClaims } | { ok: false; reason: TokenRefusal };

export function parseAskClaims(raw: unknown, now: number): AskClaims | TokenRefusal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'claims';
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => !CLAIMS.has(k))) return 'claims';
  if (typeof o.agent !== 'string' || !UUID_RE.test(o.agent)) return 'claims';
  // eslint-disable-next-line no-control-regex
  if (typeof o.sub !== 'string' || o.sub.length > MAX_SUB || o.sub.trim() === '' || /[\u0000-\u001f\u007f]/.test(o.sub)) return 'claims';
  if (typeof o.exp !== 'number' || !Number.isFinite(o.exp)) return 'claims';
  if (o.iat !== undefined && (typeof o.iat !== 'number' || !Number.isFinite(o.iat) || o.iat > now + SKEW_SEC)) return 'claims';
  const params: Record<string, LockValue[]> = Object.create(null) as Record<string, LockValue[]>;
  // No `params` is no lock: refused here, never an open Assistant. The asker then checks each required column.
  if (!o.params || typeof o.params !== 'object' || Array.isArray(o.params)) return 'claims';
  const cols = Object.keys(o.params);
  if (!cols.length || cols.length > MAX_LOCK_COLUMNS) return 'claims';
  for (const col of cols) {
    if (!col || col.length > MAX_COLUMN_LEN || col === '__proto__') return 'claims';
    const vals = lockValues((o.params as Record<string, unknown>)[col]);
    if (!vals) return 'claims';
    params[col] = vals;
  }
  if (o.exp < now - SKEW_SEC) return 'expired';
  if (o.exp > now + ASK_MAX_TTL_SEC + SKEW_SEC) return 'exp_too_far';
  return { agent: o.agent, sub: o.sub, params, exp: o.exp };
}

/** `token` against the org's `secret` (never the preview key), MAC first, then the claims. */
export function verifyAskToken(token: string, secret: string, now: number): AskVerified {
  const m = verifyMac(token, secret);
  if (!m.ok) return m;
  const claims = parseAskClaims(m.raw, now);
  return typeof claims === 'string' ? { ok: false, reason: claims } : { ok: true, claims };
}
