// Personal API tokens (T3.4): `Authorization: Bearer ord_…` for the CLI, MCP
// (/api/mcp) and the RPC API. A bearer request runs as the token's user, with
// that user's CURRENT org role — a role change or a disable applies at once.
//
// At rest a token is its sha256 (`token_hash`, what a request is looked up by)
// plus a short public prefix for lists; the value exists only in the reply to
// `tokens:create`, once. Revoked, expired and disabled-user tokens identify
// nobody (→ 401). A token cannot mint another one: creating needs a browser
// session, so a leaked token cannot make itself permanent.

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

/**
 * Who a bearer header signs in, or null. One UPDATE stamps last_used_at.
 * ponytail: a write per bearer request, like sessions; throttle if Postgres
 * write load ever shows it.
 */
export async function tokenIdentity(pool: Pool, header: string): Promise<Identity | null> {
  const token = BEARER_RE.exec(header)?.[1];
  if (!token || !TOKEN_RE.test(token)) return null;
  const r = await pool.query<{ email: string; role: Role; org_id: string }>(
    `UPDATE api_tokens t SET last_used_at = now()
       FROM users u
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
        AND u.id = t.user_id AND u.disabled_at IS NULL
      RETURNING u.email, u.role, u.org_id`,
    [hashId(token)],
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
}

/** The caller's user id (their org membership row). */
async function me(pool: Pool): Promise<string> {
  const { org, user } = ctx();
  const r = await pool.query<{ id: string }>('SELECT id FROM users WHERE org_id = $1 AND email = $2', [org.id, user.email]);
  if (!r.rows[0]) throw new Error('no user row for the caller');
  return r.rows[0].id;
}

/** Registers tokens:list / tokens:create / tokens:revoke; `pool()` is read per call. */
export function register(pool: () => Pool | null): void {
  const db = (): Pool => {
    const p = pool();
    if (!p) throw new Error('API tokens need Postgres (DATABASE_URL)');
    return p;
  };

  registry.handle('tokens:list', async (): Promise<TokenRow[]> => {
    const r = await db().query<TokenRow>(
      `SELECT id, name, prefix, to_json(created_at) #>> '{}' AS "createdAt", to_json(last_used_at) #>> '{}' AS "lastUsedAt"
         FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id`,
      [await me(db())],
    );
    return r.rows;
  });

  registry.handle('tokens:create', async (_e, { name }: { name: string }) => {
    if (ctx().via === 'token') return { ok: false as const, error: 'session' };
    const userId = await me(db());
    const token = newToken();
    // The cap check and the insert are one statement, so two quick creates cannot both pass it.
    const r = await db().query<{ id: string; createdAt: string }>(
      `INSERT INTO api_tokens (user_id, name, token_hash, prefix)
       SELECT $1, $2, $3, $4 WHERE (SELECT count(*) FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL) < $5
       RETURNING id, to_json(created_at) #>> '{}' AS "createdAt"`,
      [userId, name, hashId(token), token.slice(0, PREFIX_LEN), MAX_LIVE],
    );
    if (!r.rows[0]) return { ok: false as const, error: 'limit' };
    return { ok: true as const, id: r.rows[0].id, name, prefix: token.slice(0, PREFIX_LEN), createdAt: r.rows[0].createdAt, token };
  });

  registry.handle('tokens:revoke', async (_e, { id }: { id: string }) => {
    const r = await db().query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [
      id,
      await me(db()),
    ]);
    return { ok: r.rowCount === 1 };
  });
}
