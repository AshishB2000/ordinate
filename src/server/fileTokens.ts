// Upload and download tokens as rows every pod reads (0021 `file_tokens`,
// docs/any-pod/00-design.md §3.3) — the Postgres half of ./files.ts.
//
// A row holds the sha256 of its token, never the token; the org, user and
// kind it was issued to; and the staging place of its bytes (./staging.ts).
// THE TAKE is one conditional UPDATE naming the org, the user and the kind, so
// a wrong caller — another org, another user, the other kind — matches nothing
// and burns nothing, a used or expired token matches nothing, and two takes at
// once serialise on the row: exactly one wins. All look the same to a caller.
//
// The row is written BEFORE the bytes go up and deleted only AFTER they are
// gone, so a row always names every object that may exist; the sweep
// (`sweep`, the `shared:sweep` job) is the backstop for both orders failing.
// The one exception is an EVICTION (`evictWaiting`, NV-43/NV-55): a user may
// keep only MAX_WAITING files, MAX_WAITING_BYTES in all, waiting for their take
// — past that their oldest waiting rows are deleted first, as a staged import's
// are (src/data/stageStore.ts), and the caller deletes the bytes.

import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { inOrg } from './db/orgTx';
import * as staging from './staging';

let db: Pool | null = null;

/** Tokens in Postgres through this pool (server with DATABASE_URL, after migrations), or the in-process Map with null. */
export function useFileTokenDb(pool: Pool | null): void {
  db = pool;
}

export function dbOn(): boolean {
  return db !== null;
}

function pool(): Pool {
  if (!db) throw new Error('file tokens: no database');
  return db;
}

export const hashOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** Files one user may have waiting for their take at once, uploads and downloads together (NV-43, NV-55)… */
export const MAX_WAITING = 8;
/** …and the bytes they may hold. Past either the oldest go; the newest always stays, so one file at the upload cap still works. */
export const MAX_WAITING_BYTES = 1024 ** 3;

export interface NewRow {
  readonly org: string;
  readonly user: string;
  readonly kind: 'upload' | 'download';
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly ttlMs: number;
}

export async function insert(token: string, r: NewRow): Promise<void> {
  await inOrg(pool(), r.org, (c) => c.query(
    `INSERT INTO file_tokens (token_hash, org_id, user_email, kind, storage_key, name, size, expires_at)
     VALUES ($2, $1, $3, $4, $5, $6, $7, now() + $8 * interval '1 millisecond')`,
    [r.org, hashOf(token), r.user, r.kind, staging.checkName(r.key), r.name, r.size, r.ttlMs],
  ));
}

/** Starts a token's hour over from now — once its bytes have landed (an S3 PUT can take a while). False: the row is gone (evicted meanwhile). */
export async function restartExpiry(org: string, hash: Buffer, ttlMs: number): Promise<boolean> {
  const r = await inOrg(pool(), org, (c) => c.query(
    `UPDATE file_tokens SET expires_at = now() + $3 * interval '1 millisecond' WHERE org_id = $1 AND token_hash = $2`,
    [org, hash, ttlMs],
  ));
  return (r.rowCount ?? 0) > 0;
}

/**
 * Deletes `user`'s waiting rows (unused, unexpired) past the newest MAX_WAITING, or past MAX_WAITING_BYTES
 * counted newest first — never `keep`'s, the one just issued. Returns what each named: deleting the bytes
 * is the caller's. A row a take already won is untouched (`used_at IS NULL` is re-checked on the row).
 */
export async function evictWaiting(org: string, user: string, keep: Buffer): Promise<{ hash: Buffer; key: string }[]> {
  const r = await inOrg(pool(), org, (c) => c.query<{ token_hash: Buffer; storage_key: string }>(
    `DELETE FROM file_tokens WHERE org_id = $1 AND used_at IS NULL AND token_hash IN (
       SELECT token_hash FROM (
         SELECT token_hash, row_number() OVER w AS n, sum(size) OVER w AS bytes
           FROM file_tokens
          WHERE org_id = $1 AND user_email = $2 AND used_at IS NULL AND expires_at > now()
         WINDOW w AS (ORDER BY token_hash = $3 DESC, created_at DESC, token_hash ROWS UNBOUNDED PRECEDING)) r
        WHERE n > 1 AND (n > $4 OR bytes > $5))
     RETURNING token_hash, storage_key`,
    [org, user, keep, MAX_WAITING, MAX_WAITING_BYTES],
  ));
  return r.rows.map((x) => ({ hash: x.token_hash, key: x.storage_key }));
}

export interface TakenRow {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  /** The used_at this take wrote (ms precision) — the compare-and-set of `untake`. */
  readonly usedAt: Date;
}

/** THE TAKE. The row, now used, when this caller may use it; else null. Called through the module object (a test preload swaps it). */
export async function takeRow(org: string, user: string, kind: 'upload' | 'download', hash: Buffer): Promise<TakenRow | null> {
  const r = await inOrg(pool(), org, (c) => c.query<{ storage_key: string; name: string; size: string; used_at: Date }>(
    `UPDATE file_tokens SET used_at = date_trunc('milliseconds', now())
      WHERE token_hash = $2 AND org_id = $1 AND user_email = $3 AND kind = $4
        AND used_at IS NULL AND expires_at > now()
     RETURNING storage_key, name, size, used_at`,
    [org, hash, user, kind],
  ));
  const row = r.rows[0];
  return row ? { key: row.storage_key, name: row.name, size: Number(row.size), usedAt: row.used_at } : null;
}

/** Undoes a take whose bytes could not be fetched (a transient S3 failure) — only if nothing touched it since. */
export async function untake(org: string, hash: Buffer, usedAt: Date): Promise<boolean> {
  const r = await inOrg(pool(), org, (c) => c.query(
    'UPDATE file_tokens SET used_at = NULL WHERE org_id = $1 AND token_hash = $2 AND used_at = $3',
    [org, hash, usedAt],
  ));
  return (r.rowCount ?? 0) > 0;
}

export async function remove(org: string, hash: Buffer): Promise<void> {
  await inOrg(pool(), org, (c) => c.query('DELETE FROM file_tokens WHERE org_id = $1 AND token_hash = $2', [org, hash]));
}

/** Of these hashes (hex), the ones still waiting for their take: a row, unused, unexpired. */
export async function waiting(org: string, hexes: readonly string[]): Promise<Set<string>> {
  if (!hexes.length) return new Set();
  const r = await inOrg(pool(), org, (c) => c.query<{ h: string }>(
    `SELECT encode(token_hash, 'hex') AS h FROM file_tokens
      WHERE org_id = $1 AND token_hash IN (SELECT decode(h, 'hex') FROM unnest($2::text[]) AS h) AND used_at IS NULL AND expires_at > now()`,
    [org, [...hexes]],
  ));
  return new Set(r.rows.map((x) => x.h));
}

// Never taken and expired (the grace lets a download that started just before
// expiry finish), or taken long ago by a handler that never called done() (a crash).
const DUE = `org_id = $1 AND ((used_at IS NULL AND expires_at < now() - interval '10 minutes') OR used_at < now() - interval '24 hours')`; // a used upload: a restore job may read it for hours (files.ts USED_GRACE_MS)

/** One sweep for `org`: each due row's bytes, then the row (./staging.ts `sweepRows`). */
export async function sweep(p: Pool, org: string): Promise<number> {
  return (await staging.sweepRows(p, org,
    `SELECT token_hash AS k, storage_key FROM file_tokens WHERE ${DUE}`,
    'DELETE FROM file_tokens WHERE org_id = $1 AND token_hash = $2')).length;
}
