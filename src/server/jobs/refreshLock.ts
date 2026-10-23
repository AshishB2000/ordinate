// One refresh of a dataset at a time ACROSS PODS (L0.4) — a Postgres advisory
// lock per (org, dataset).
//
// In one process, refreshes are already serialized: src/app/jobs.ts runs one
// job per dataset and src/data/datasetRefresh.ts chains direct calls. Those are
// memory, so with N pods a ↻ on one, the scheduler's tick on another and a hook
// (L0.5) or a fresh-on-ask pull (L3.1) on a third could each refresh the same
// dataset at once — three fetches from the source, and three writes racing for
// the record where the last one wins.
//
// THE LOCK. `pg_try_advisory_lock(hashtext(org || ':' || dataset))`, taken on a
// DEDICATED client checked out of the pool for the length of the refresh, and
// released in a `finally` on every path. Session-level, so a pod that dies
// mid-refresh drops it with its connection; nothing is left to expire. "Try",
// never wait: a refresh that finds it held COALESCES — it starts nothing and
// says so (src/data/refreshJob.ts `startRefresh`), because the one already
// running is about to land the same fresh rows.
//
// A client that cannot prove it let go (the unlock failed, or answered false)
// is DESTROYED rather than returned to the pool: an idle pooled connection
// still holding the lock would block that dataset on every pod until it closed.
// While it is held it carries its own 'error' listener: the pool listens only
// to IDLE clients, and a connection lost mid-refresh (a database restart) would
// otherwise be an uncaught 'error' that takes the pod down. Lost, the lock went
// with the session; the refresh carries on, as it would have without Postgres.
//
// hashtext() folds the key to 32 bits, so two different datasets can share a
// lock. Harmless: the worst case is that they refresh one after the other (the
// second coalesces and runs on its next turn); one dataset is never refreshed
// twice at once.
//
// Without DATABASE_URL there is one process and no pool: `withRefreshLock` just
// runs, and the in-process guards above are the whole story.
//
// Pool budget: a running refresh holds one of the pod's 10 clients (pool.ts),
// at most jobs.MAX_RUNNING (3) of them — refreshes only take this lock as jobs.

import type { Pool, PoolClient } from 'pg';
import { ctx } from '../context';

let pool: Pool | null = null;

/** Lock refreshes across pods through this pool (server with DATABASE_URL, after migrations), or stop with null. */
export function useRefreshLockDb(p: Pool | null): void {
  pool = p;
}

/** Is the cross-pod lock in use (a server with Postgres)? */
export function refreshLockOn(): boolean {
  return pool !== null;
}

/** The text hashtext() folds: the org, then the dataset id (a UUID). */
export function lockKey(org: string, datasetId: string): string {
  return `${org}:${datasetId}`;
}

export type Locked<T> = { ran: true; value: T } | { ran: false };

const TRY = 'SELECT pg_try_advisory_lock(hashtext($1)) AS got';
const UNLOCK = 'SELECT pg_advisory_unlock(hashtext($1)) AS released';

/** Releases the lock; false when it cannot be shown to be released (the client is then destroyed). */
async function unlock(client: PoolClient, key: string): Promise<boolean> {
  try {
    const r = await client.query<{ released: boolean }>(UNLOCK, [key]);
    return r.rows[0]?.released === true;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` holding the refresh lock of `datasetId` in the caller's org, or
 * returns `{ ran: false }` WITHOUT running it when any session — this pod's or
 * another's — holds it. `fn`'s own throw passes through, after the release.
 */
export async function withRefreshLock<T>(datasetId: string, fn: () => Promise<T>): Promise<Locked<T>> {
  const p = pool;
  if (!p) return { ran: true, value: await fn() };
  const key = lockKey(ctx().org.id, datasetId);
  const client = await p.connect();
  let destroy = false;
  const lost = (): void => { destroy = true; };
  client.on('error', lost);
  try {
    let got: boolean;
    try {
      got = (await client.query<{ got: boolean }>(TRY, [key])).rows[0]?.got === true;
    } catch (err) {
      destroy = true; // whether the lock was taken is unknown
      throw err;
    }
    if (!got) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      if (!(await unlock(client, key))) destroy = true;
    }
  } finally {
    client.removeListener('error', lost);
    client.release(destroy);
  }
}

// pg_locks shows a one-bigint advisory key as classid = its high 32 bits and
// objid = its low 32 bits (both oid, so unsigned), objsubid = 1. hashtext()'s
// int4 widens to int8 with its sign, so a negative hash has the high half set.
const HELD = `
  WITH k AS (SELECT hashtext($1)::int8 AS v)
  SELECT EXISTS (
    SELECT 1 FROM pg_locks, k
     WHERE locktype = 'advisory' AND granted AND objsubid = 1
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = ((k.v >> 32) & 4294967295)::oid
       AND objid = (k.v & 4294967295)::oid
  ) AS held`;

/**
 * Is a refresh of `datasetId` (caller's org) running on ANY pod? A read of
 * pg_locks — it never takes the lock, so asking cannot make a refresh that is
 * starting at that instant coalesce. False without Postgres.
 */
export async function refreshLockHeld(datasetId: string): Promise<boolean> {
  const p = pool;
  if (!p) return false;
  const r = await p.query<{ held: boolean }>(HELD, [lockKey(ctx().org.id, datasetId)]);
  return r.rows[0]?.held === true;
}
