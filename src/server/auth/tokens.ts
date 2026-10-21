// Personal API tokens (T3.4): `Authorization: Bearer ord_…` for the CLI, MCP
// (/api/mcp) and the RPC API. A bearer request runs as the token's user, with
// that user's CURRENT org role — a role change or a disable applies at once.
//
// At rest a token is its sha256 (`token_hash`, what a request is looked up by)
// plus a short public prefix for lists; the value exists only in the reply to
// `tokens:create`, once. Revoked, expired and disabled-user tokens identify
// nobody (→ 401). A token cannot mint another one: creating needs a browser
// session, so a leaked token cannot make itself permanent.
//
// Every token has an end (docs/sso-lifecycle §3.14): `expires_at`, chosen at
// creation (1 to API_TOKEN_MAX_DAYS), and never later than `created_at +
// API_TOKEN_MAX_DAYS` — so a token made before tokens had an end expires that
// long after it was made, and lowering the maximum shortens every token.

import { randomBytes } from 'crypto';
import type { Pool } from 'pg';
import { ctx, type Identity, type Role } from '../context';
import { registry } from '../rpc';
import { hashId } from './store';

const TOKEN_RE = /^ord_[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;
/** What lists show: `ord_` and 8 more characters (48 random bits — names a token, cannot be guessed from). */
const PREFIX_LEN = 12;
const MAX_LIVE = 50;

/** 256 random bits, base64url, with a recognisable prefix (secret scanners match `ord_`). */
export const newToken = (): string => 'ord_' + randomBytes(32).toString('base64url');

/** Is there a bearer credential on this request at all (even a malformed one)? */
export function hasBearer(header: unknown): boolean {
  return typeof header === 'string' && /^Bearer\s/i.test(header);
}

/** A token's effective end, in SQL (`$max` = API_TOKEN_MAX_DAYS): its own, never past created_at + the maximum. */
const ENDS = (max: string) => `least(coalesce(t.expires_at, 'infinity'::timestamptz), t.created_at + ${max} * interval '1 day')`;

/**
 * Who a bearer header signs in, or null. One UPDATE stamps last_used_at.
 * ponytail: a write per bearer request, like sessions; throttle if Postgres
 * write load ever shows it.
 */
export async function tokenIdentity(pool: Pool, header: string, maxDays: number): Promise<Identity | null> {
  const token = BEARER_RE.exec(header)?.[1];
  if (!token || !TOKEN_RE.test(token)) return null;
  const r = await pool.query<{ email: string; role: Role; org_id: string }>(
    `UPDATE api_tokens t SET last_used_at = now()
       FROM users u
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND ${ENDS('$2')} > now()
        AND u.id = t.user_id AND u.disabled_at IS NULL
      RETURNING u.email, u.role, u.org_id`,
    [hashId(token), maxDays],
  );
  const row = r.rows[0];
  return row ? { user: { email: row.email, role: row.role }, org: { id: row.org_id }, via: 'token' } : null;
}

export interface TokenRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  /** When it stops working (its effective end). */
  readonly expiresAt: string;
  readonly expired: boolean;
  /** Made before tokens had an end: it ends API_TOKEN_MAX_DAYS after it was made. */
  readonly legacy: boolean;
}

/** The caller's user id (their org membership row). */
async function me(pool: Pool): Promise<string> {
  const { org, user } = ctx();
  const r = await pool.query<{ id: string }>('SELECT id FROM users WHERE org_id = $1 AND email = $2', [org.id, user.email]);
  if (!r.rows[0]) throw new Error('no user row for the caller');
  return r.rows[0].id;
}

/** Registers tokens:list / tokens:create / tokens:revoke; `pool()` and `maxDays()` (API_TOKEN_MAX_DAYS) are read per call. */
export function register(pool: () => Pool | null, maxDays: () => number): void {
  const db = (): Pool => {
    const p = pool();
    if (!p) throw new Error('API tokens need Postgres (DATABASE_URL)');
    return p;
  };

  // Every unrevoked token, expired ones too (marked: a script that stopped working is explained), and the maximum.
  registry.handle('tokens:list', async (): Promise<{ tokens: TokenRow[]; maxDays: number }> => {
    const max = maxDays();
    const r = await db().query<TokenRow>(
      `SELECT id, name, prefix, to_json(created_at) #>> '{}' AS "createdAt", to_json(last_used_at) #>> '{}' AS "lastUsedAt",
              to_json(${ENDS('$2')}) #>> '{}' AS "expiresAt", ${ENDS('$2')} <= now() AS expired, expires_at IS NULL AS legacy
         FROM api_tokens t WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id`,
      [await me(db()), max],
    );
    return { tokens: r.rows, maxDays: max };
  });

  registry.handle('tokens:create', async (_e, { name, expiresInDays }: { name: string; expiresInDays: number }) => {
    if (ctx().via === 'token') return { ok: false as const, error: 'session' };
    const max = maxDays();
    if (expiresInDays > max) return { ok: false as const, error: 'expiry' };
    const userId = await me(db());
    const token = newToken();
    // The cap check and the insert are one statement, so two quick creates cannot both pass it. Expired tokens do not count.
    const r = await db().query<{ id: string; createdAt: string; expiresAt: string }>(
      `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
       SELECT $1, $2, $3, $4, now() + $6 * interval '1 day'
        WHERE (SELECT count(*) FROM api_tokens t WHERE user_id = $1 AND revoked_at IS NULL AND ${ENDS('$7')} > now()) < $5
       RETURNING id, to_json(created_at) #>> '{}' AS "createdAt", to_json(expires_at) #>> '{}' AS "expiresAt"`,
      [userId, name, hashId(token), token.slice(0, PREFIX_LEN), MAX_LIVE, expiresInDays, max],
    );
    if (!r.rows[0]) return { ok: false as const, error: 'limit' };
    const { id, createdAt, expiresAt } = r.rows[0];
    return { ok: true as const, id, name, prefix: token.slice(0, PREFIX_LEN), createdAt, expiresAt, token };
  });

  registry.handle('tokens:revoke', async (_e, { id }: { id: string }) => {
    const r = await db().query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [
      id,
      await me(db()),
    ]);
    return { ok: r.rowCount === 1 };
  });
}
