// Refresh URLs at rest (live data L0.5, table `refresh_hooks`, 0011_refresh_hooks.sql).
//
// A refresh URL is `/api/hooks/refresh/<token>`: a capability for ONE action
// on ONE dataset. The token is `ordh_` + 32 random bytes (base64url) — a
// prefix secret scanners can match, like a personal token's `ord_`. The value
// exists only in the reply that created it; the table keeps its sha256
// (`token_hash`, what a call is looked up by) and `ordh_` + 8 characters
// (`prefix`, 48 random bits: names it in a list, cannot be guessed from).
//
// TWO WAYS IN, both under the table's forced RLS (the migration says why):
//
//   - the org's members, through the RPC channels (./rpc.ts): every statement
//     runs with `ordinate.org` set, as src/app/recordFs.ts does;
//   - a caller holding the token, through the route (./route.ts): the URL
//     names no org, so the statement runs with `ordinate.hook` set to the
//     token's hash, and the row whose hash it is — that one, and nothing
//     else — is visible.
//
// THE RATE LIMIT IS THE CLAIM. A call stamps `last_used_at` with ONE
// conditional UPDATE (`… WHERE last_used_at <= now() - interval`). Two pods
// claiming the same hook at once serialize on the row lock, and the second
// re-checks the condition against the first's stamp and claims nothing, so at
// most one call per REFRESH_HOOK_MIN_INTERVAL_SEC gets through ACROSS PODS,
// on the database's clock. A claim that is then refused (the creator lost
// access) still spent the interval: that bounds every kind of work a leaked
// URL can cause, audit rows included.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { ORG_RE } from '../../app/paths';

/** The route (Fastify's pattern): app.ts's gate, csrf.ts and limits.ts name it, so it lives in this light module. */
export const HOOK_ROUTE = '/api/hooks/refresh/*';
export const HOOK_TOKEN_PREFIX = 'ordh_';
const TOKEN_RE = /^ordh_[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
/** What lists show: `ordh_` and 8 more characters. */
export const PREFIX_LEN = 13;
/** Live (unrevoked) URLs per dataset — one per pipeline is plenty. A soft cap: two creates racing may both pass. */
export const MAX_LIVE_PER_DATASET = 10;
/** The newest this many, revoked included, are listed. */
const LIST_MAX = 50;

/** 256 random bits, base64url, behind the recognisable prefix. */
export const newHookToken = (): string => HOOK_TOKEN_PREFIX + randomBytes(32).toString('base64url');

export const isHookToken = (s: unknown): s is string => typeof s === 'string' && TOKEN_RE.test(s);

/** The hex sha256 a token is stored and looked up by. */
export const hookHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** One hook as the list shows it: never the hash, never the token. */
export interface HookRow {
  readonly id: string;
  readonly prefix: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/** A claimed hook: what the route acts on. */
export interface ClaimedHook {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly datasetId: string;
  readonly createdBy: string;
}

export type Claim =
  | { readonly kind: 'claimed'; readonly hook: ClaimedHook }
  /** Live, but called again inside the interval. Only a holder of the token can get here. */
  | { readonly kind: 'too_soon'; readonly retryAfterSec: number }
  /** Unknown and revoked are ONE answer, reached through the same two statements. */
  | { readonly kind: 'unknown' };

/**
 * One transaction with an RLS setting. `value` is checked against its shape
 * before it is inlined (`setting` is one of two literals), as recordFs does it:
 * one round trip for BEGIN and the setting.
 */
async function within<T>(pool: Pool, setting: 'ordinate.org' | 'ordinate.hook', value: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!(setting === 'ordinate.org' ? ORG_RE : HASH_RE).test(value)) throw new Error(`invalid ${setting}`);
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query(`BEGIN; SELECT set_config('${setting}', '${value}', true)`);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch((e: Error) => { broken = e; });
    throw err;
  } finally {
    c.release(broken);
  }
}

const COLS = `id, prefix, created_by AS "createdBy", to_json(created_at) #>> '{}' AS "createdAt",
  to_json(last_used_at) #>> '{}' AS "lastUsedAt", to_json(revoked_at) #>> '{}' AS "revokedAt"`;

/** The dataset's hooks, newest first, revoked ones included (greyed in the list). */
export function listHooks(pool: Pool, org: string, projectId: string, datasetId: string): Promise<HookRow[]> {
  return within(pool, 'ordinate.org', org, async (c) => (await c.query<HookRow>(
    `SELECT ${COLS} FROM refresh_hooks WHERE org_id = $1 AND project_id = $2 AND dataset_id = $3
      ORDER BY created_at DESC, id LIMIT ${LIST_MAX}`,
    [org, projectId, datasetId],
  )).rows);
}

/** A new hook and its token, or null at the cap. The token is in this reply and nowhere else, ever. */
export function createHook(pool: Pool, org: string, projectId: string, datasetId: string, createdBy: string): Promise<{ hook: HookRow; token: string } | null> {
  const token = newHookToken();
  return within(pool, 'ordinate.org', org, async (c) => {
    const r = await c.query<HookRow>(
      `INSERT INTO refresh_hooks (org_id, project_id, dataset_id, token_hash, prefix, created_by)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE (SELECT count(*) FROM refresh_hooks WHERE org_id = $1 AND project_id = $2 AND dataset_id = $3 AND revoked_at IS NULL) < $7
       RETURNING ${COLS}`,
      [org, projectId, datasetId, hookHash(token), token.slice(0, PREFIX_LEN), createdBy, MAX_LIVE_PER_DATASET],
    );
    return r.rows[0] ? { hook: r.rows[0], token } : null;
  });
}

/** Revoke one of the project's hooks. False when it is not the project's, or already revoked. */
export function revokeHook(pool: Pool, org: string, projectId: string, id: string): Promise<boolean> {
  return within(pool, 'ordinate.org', org, async (c) =>
    (await c.query('UPDATE refresh_hooks SET revoked_at = now() WHERE org_id = $1 AND project_id = $2 AND id = $3 AND revoked_at IS NULL', [org, projectId, id]))
      .rowCount === 1);
}

/**
 * Claim the hook a call presents, or say why not. Always the same two
 * statements when nothing is claimed — the UPDATE, then a SELECT for the wait
 * — whether the token is unknown or revoked, so neither the answer nor its
 * shape tells them apart. The hash the row was found by is compared again in
 * constant time before it is believed.
 */
export function claimHook(pool: Pool, token: string, minIntervalSec: number): Promise<Claim> {
  const hash = hookHash(token);
  return within(pool, 'ordinate.hook', hash, async (c) => {
    const won = await c.query<{ id: string; org_id: string; project_id: string; dataset_id: string; token_hash: string; created_by: string }>(
      `UPDATE refresh_hooks SET last_used_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL
          AND (last_used_at IS NULL OR last_used_at <= now() - $2 * interval '1 second')
       RETURNING id, org_id, project_id::text, dataset_id::text, token_hash, created_by`,
      [hash, minIntervalSec],
    );
    const row = won.rows[0];
    if (row) {
      if (!timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash, 'hex'))) return { kind: 'unknown' } as const;
      return { kind: 'claimed', hook: { id: row.id, orgId: row.org_id, projectId: row.project_id, datasetId: row.dataset_id, createdBy: row.created_by } } as const;
    }
    // A new statement: it sees a claim another pod committed while this one waited on the row.
    const seen = await c.query<{ live: boolean; wait: number }>(
      `SELECT revoked_at IS NULL AS live,
              GREATEST(1, CEIL(EXTRACT(EPOCH FROM last_used_at + $2 * interval '1 second' - now())))::int AS wait
         FROM refresh_hooks WHERE token_hash = $1`,
      [hash, minIntervalSec],
    );
    const s = seen.rows[0];
    return s?.live ? ({ kind: 'too_soon', retryAfterSec: s.wait ?? 1 } as const) : ({ kind: 'unknown' } as const);
  });
}
