// What Live sends to the warehouse, counted — MAIN PROCESS ONLY.
// docs/live-data/00-plan.md L2.7 (D9, R-L2); table `live_usage`, 0012_live_usage.sql.
//
// One row per org, UTC day and connection: statements sent, bytes billed (as
// the warehouse reports them), statements refused by the daily limit. Every
// warehouse statement the executor sends is ADMITTED here first
// (src/engine/live/liveBudget.ts checkDaily), and its bytes are added when the
// warehouse answers (noteCall).
//
// ADMISSION IS THE COUNT. "Is the org under LIVE_DAILY_QUERY_LIMIT?" and "count
// this statement" are one step, not two: a check followed by a later count
// lets every pod through at limit − 1 (N pods × LIVE_MAX_CONCURRENT past it).
// With Postgres the step is one transaction holding a per-(org, day) advisory
// lock: it reads the org's sum and upserts `queries + 1` — or, past the limit,
// `refused + 1` — so whatever the pods, exactly `limit` statements a day get
// through, and exactly one refusal is the day's first (the one that tells the
// org's admins). A statement is counted when admitted, whether the warehouse
// then answers, fails or is cancelled: each of those can bill.
//
// WITHOUT DATABASE_URL the rows are in memory, PER POD and since it started,
// keyed with orgKey(); the admin page says so. JavaScript runs one admission at
// a time, so the count is exact within the pod.

import type { Pool, PoolClient } from 'pg';
import { ORG_RE } from '../../app/paths';
import { isValidId } from '../../app/ids';
import { ctx, orgKey } from '../context';

/** Which connection (and the project it lives in) a statement is sent through. */
export interface UsageKey {
  readonly projectId: string;
  readonly connectionId: string;
}

/** An admitted statement: where its bytes go when the warehouse answers. */
export interface Ticket {
  readonly org: string;
  readonly day: string;
  readonly connectionId: string;
  /** The store that admitted it: Postgres, or this pod's memory (null, with the row's orgKey'd key). */
  readonly pool: Pool | null;
  readonly memKey: string | null;
}

export type Admission =
  | { readonly admitted: true; readonly ticket: Ticket }
  /** `first`: the org's first refusal of `day`, across pods — the one that tells its admins. */
  | { readonly admitted: false; readonly first: boolean; readonly day: string };

/** One (day, connection) of the caller's org. `bytes` null: no statement of it reported a byte figure. */
export interface UsageRow {
  readonly day: string;
  readonly connectionId: string;
  readonly projectId: string;
  readonly queries: number;
  readonly bytes: number | null;
  readonly refused: number;
}

// ── Where the rows are ─────────────────────────────────────────────────────

let db: { pool: Pool; devAuth: boolean } | null = null;

/** Count in Postgres through `pool` (server with DATABASE_URL, after migrations), or in memory with null. `devAuth`: AUTH_MODE=dev. */
export function useLiveUsageDb(pool: Pool | null, devAuth = false): void {
  db = pool ? { pool, devAuth } : null;
}

/** The Postgres the counts go to, and whether every member is the dev admin; null: this pod's memory. */
export function liveUsageDb(): { readonly pool: Pool; readonly devAuth: boolean } | null {
  return db;
}

// ── The day ─────────────────────────────────────────────────────────────────

let clock: () => number = Date.now;

/** Test hook: a fake clock for the day (null restores Date.now). */
export function setUsageClockForTest(fn: (() => number) | null): void {
  clock = fn ?? Date.now;
}

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC day `daysAgo` days before now, as `YYYY-MM-DD`. Every pod's clock, not the database's: a few seconds of skew at midnight move one statement to the next day. */
export function utcDay(daysAgo = 0): string {
  return new Date(clock() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

function checked(org: string, day: string | null, k?: UsageKey): void {
  if (!ORG_RE.test(org)) throw new Error('live usage: invalid org id');
  if (day !== null && !DAY_RE.test(day)) throw new Error('live usage: invalid day');
  if (k && !(isValidId(k.projectId) && isValidId(k.connectionId))) throw new Error('live usage: invalid project or connection id');
}

// ── Postgres ────────────────────────────────────────────────────────────────

/**
 * One transaction with `ordinate.org` set for the table's forced RLS, and —
 * with `lockDay` — the org's per-day advisory lock, held until COMMIT. Both
 * values are checked against their shapes before they are inlined (as
 * src/server/hooks/store.ts does), so BEGIN, the setting and the lock are one
 * round trip.
 */
async function within<T>(pool: Pool, org: string, lockDay: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  checked(org, lockDay);
  const lock = lockDay ? `; SELECT pg_advisory_xact_lock(hashtextextended('live_usage:${org}:${lockDay}', 0))` : '';
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query(`BEGIN; SELECT set_config('ordinate.org', '${org}', true)${lock}`);
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

// The org's day BEFORE this statement (a statement-start snapshot, taken after
// the lock is held), and one upsert that counts it as a query or a refusal.
const ADMIT = `
  WITH t AS (
    SELECT coalesce(sum(queries), 0)::bigint AS q, coalesce(sum(refused), 0)::bigint AS r
      FROM live_usage WHERE org_id = $1 AND day = $2::date
  ), d AS (
    SELECT ($5::bigint = 0 OR t.q < $5::bigint) AS admitted, t.r FROM t
  ), up AS (
    INSERT INTO live_usage AS u (org_id, day, connection_id, project_id, queries, refused)
    SELECT $1, $2::date, $3::uuid, $4::uuid, CASE WHEN d.admitted THEN 1 ELSE 0 END, CASE WHEN d.admitted THEN 0 ELSE 1 END FROM d
    ON CONFLICT (org_id, day, connection_id) DO UPDATE
      SET queries = u.queries + excluded.queries, refused = u.refused + excluded.refused,
          project_id = excluded.project_id, updated_at = now()
    RETURNING 1
  )
  SELECT d.admitted, d.r::text AS r FROM d, up`;

async function admitDb(pool: Pool, org: string, day: string, k: UsageKey, limit: number): Promise<Admission> {
  // No limit, nothing to race for: the upsert alone is atomic on its row.
  const r = await within(pool, org, limit > 0 ? day : null, (c) =>
    c.query<{ admitted: boolean; r: string }>(ADMIT, [org, day, k.connectionId, k.projectId, limit]));
  const row = r.rows[0];
  if (!row) throw new Error('live usage: the admission wrote no row');
  return row.admitted ? { admitted: true, ticket: { org, day, connectionId: k.connectionId, pool, memKey: null } } : { admitted: false, first: row.r === '0', day };
}

// ── Memory (no DATABASE_URL): this pod's, keyed with orgKey() ──────────────

interface MemRow {
  day: string;
  connectionId: string;
  projectId: string;
  queries: number;
  bytes: number | null;
  refused: number;
}

const mem = new Map<string, MemRow>();
let prunedFor = '';
/** The window the admin page shows, plus a day: older rows are dropped from memory. */
const KEEP_DAYS = 31;

/** The caller's org's rows of `day` (orgKey: the same ids in another org are other rows). */
const dayPrefix = (day: string): string => orgKey(`live-usage\u0000${day}\u0000`);

function prune(today: string): void {
  if (prunedFor === today) return;
  prunedFor = today;
  const oldest = utcDay(KEEP_DAYS);
  for (const [key, row] of mem) if (row.day < oldest) mem.delete(key);
}

function admitMem(org: string, day: string, k: UsageKey, limit: number): Admission {
  prune(day);
  const prefix = dayPrefix(day);
  let q = 0;
  let refused = 0;
  for (const [key, row] of mem) {
    if (!key.startsWith(prefix)) continue;
    q += row.queries;
    refused += row.refused;
  }
  const memKey = prefix + k.connectionId;
  let row = mem.get(memKey);
  if (!row) mem.set(memKey, (row = { day, connectionId: k.connectionId, projectId: k.projectId, queries: 0, bytes: null, refused: 0 }));
  row.projectId = k.projectId;
  if (limit === 0 || q < limit) {
    row.queries += 1;
    return { admitted: true, ticket: { org, day, connectionId: k.connectionId, pool: null, memKey } };
  }
  row.refused += 1;
  return { admitted: false, first: refused === 0, day };
}

// ── The store ───────────────────────────────────────────────────────────────

/**
 * Admit one warehouse statement of the caller's org through `k`'s connection
 * under `limit` statements a UTC day (0 = no limit), counting it — or count
 * the refusal. `pool` null: this pod's memory.
 */
export async function admit(pool: Pool | null, k: UsageKey, limit: number): Promise<Admission> {
  const org = ctx().org.id;
  const day = utcDay();
  checked(org, day, k);
  return pool ? admitDb(pool, org, day, k, limit) : admitMem(org, day, k, limit);
}

/** The warehouse billed `bytes` for an admitted statement: add them to its row (the day it was admitted on). */
export async function addBytes(t: Ticket, bytes: number): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return;
  if (!t.pool) {
    // The row admission keyed (orgKey, then): the warehouse may answer after the asker's request is gone.
    const row = t.memKey ? mem.get(t.memKey) : undefined;
    if (row) row.bytes = (row.bytes ?? 0) + bytes;
    return;
  }
  await within(t.pool, t.org, null, (c) => c.query(
    'UPDATE live_usage SET bytes = coalesce(bytes, 0) + $4, updated_at = now() WHERE org_id = $1 AND day = $2::date AND connection_id = $3::uuid',
    [t.org, t.day, t.connectionId, bytes],
  ));
}

const num = (s: string | null): number | null => (s === null ? null : Number(s));

/** The caller's org's rows from `sinceDay` (inclusive), newest day first. */
export async function readUsage(pool: Pool | null, sinceDay: string): Promise<UsageRow[]> {
  const org = ctx().org.id;
  checked(org, sinceDay);
  if (!pool) {
    const own = orgKey('live-usage\u0000');
    return [...mem].filter(([key, r]) => key.startsWith(own) && r.day >= sinceDay).map(([, r]) => ({ ...r }))
      .sort((a, b) => b.day.localeCompare(a.day) || a.connectionId.localeCompare(b.connectionId));
  }
  const r = await within(pool, org, null, (c) => c.query<{ day: string; connectionId: string; projectId: string; queries: string; bytes: string | null; refused: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, connection_id::text AS "connectionId", project_id::text AS "projectId",
            queries::text AS queries, bytes::text AS bytes, refused::text AS refused
       FROM live_usage WHERE org_id = $1 AND day >= $2::date ORDER BY day DESC, connection_id`,
    [org, sinceDay],
  ));
  return r.rows.map((x) => ({ day: x.day, connectionId: x.connectionId, projectId: x.projectId, queries: Number(x.queries), bytes: num(x.bytes), refused: Number(x.refused) }));
}

/** Test hook: forget this pod's in-memory counts. */
export function clearMemoryForTest(): void {
  mem.clear();
  prunedFor = '';
}
