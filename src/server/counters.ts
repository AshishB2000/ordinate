// One counter for every abuse limit that must hold across pods
// (docs/any-pod/00-design.md §3.8): the password lockout, every email budget
// kind, Send now, the embed per-token and per-org limits.
//
// A BUCKET is a key, a limit and a window. A window opens at a key's first
// hit and lasts `windowMs`; when it ends the count starts over. `take` adds
// `by` to every bucket ALL OR NONE: a refusal charges nothing, anywhere.
//
// Two stores, one semantics:
//   Postgres (0021 `shared_counters`, with DATABASE_URL): each bucket is one
//     `INSERT … ON CONFLICT … DO UPDATE … WHERE <it still fits> RETURNING`, in
//     one transaction per take. No row back = refused, and nothing was written
//     for that key; a refusal on a later bucket rolls back the earlier ones.
//     The row lock serialises takers on one key, so N pods racing at limit − 1
//     let exactly one through. Keys are sorted, so two takes never deadlock.
//   memory (no database: one process): a Map, LRU-capped like the old lockout.
// scripts/test-sharedCounters.ts drives both through one script.
//
// Generic on purpose: a key is any string the caller builds (`login:<email>`,
// `mail:<kind>`, …); nothing here knows a kind.

import type { Pool } from 'pg';
import { inOrg } from './db/orgTx';

export interface Bucket {
  readonly key: string;
  readonly limit: number;
  readonly windowMs: number;
}

/** Each charged key with the end of the window it was charged in (ms), for a refund. */
export type Windows = ReadonlyArray<readonly [key: string, windowEnd: number]>;
export type Taken = { ok: true; windows: Windows } | { ok: false; retryAfterSec: number };

const MEMORY_KEYS = 5_000;

let db: Pool | null = null;
let now = (): number => Date.now();
const mem = new Map<string, { n: number; end: number }>();

/** Postgres through this pool (server with DATABASE_URL, after migrations), or memory with null. */
export function useCounterDb(pool: Pool | null): void {
  db = pool;
}

const secs = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/** Distinct keys in a fixed order: the lock order of a Postgres take. */
function ordered(buckets: readonly Bucket[]): Bucket[] {
  const byKey = new Map<string, Bucket>();
  for (const b of buckets) if (!byKey.has(b.key)) byKey.set(b.key, b);
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Adds `by` to every bucket's window, or nothing and a Retry-After when any of them lacks the room. */
export async function take(org: string, buckets: readonly Bucket[], by = 1): Promise<Taken> {
  const list = ordered(buckets);
  const tooBig = list.find((b) => by > b.limit);
  if (tooBig) return { ok: false, retryAfterSec: secs(tooBig.windowMs) };
  return db ? takeDb(db, org, list, by) : takeMem(org, list, by);
}

/** Gives `n` back to each window it was charged in; a window that has ended ignores it. */
export async function give(org: string, windows: Windows, n: number): Promise<void> {
  if (!(n > 0) || !windows.length) return;
  if (!db) {
    for (const [key, end] of windows) {
      const e = mem.get(org + '\0' + key);
      if (e && e.end === end) e.n = Math.max(0, e.n - n);
    }
    return;
  }
  await inOrg(db, org, async (c) => {
    for (const [key, end] of windows) {
      await c.query('UPDATE shared_counters SET n = greatest(0, n - $3) WHERE org_id = $1 AND key = $2 AND window_end = $4',
        [org, key, n, new Date(end)]);
    }
  });
}

/** Ends `key`'s window now (a right password clears its failures). */
export async function clear(org: string, key: string): Promise<void> {
  if (!db) {
    mem.delete(org + '\0' + key);
    return;
  }
  await inOrg(db, org, (c) => c.query('DELETE FROM shared_counters WHERE org_id = $1 AND key = $2', [org, key]));
}

/** The sweep (src/server/sharedSweep.ts): windows that have ended, for this org. */
export async function sweepEnded(pool: Pool, org: string): Promise<number> {
  return inOrg(pool, org, async (c) => (await c.query('DELETE FROM shared_counters WHERE org_id = $1 AND window_end < now()', [org])).rowCount ?? 0);
}

const UPSERT = `
  INSERT INTO shared_counters AS c (org_id, key, n, window_end)
  VALUES ($1, $2, $3, date_trunc('milliseconds', now() + $4 * interval '1 millisecond'))
  ON CONFLICT (org_id, key) DO UPDATE SET
    n          = CASE WHEN c.window_end <= now() THEN EXCLUDED.n ELSE c.n + EXCLUDED.n END,
    window_end = CASE WHEN c.window_end <= now() THEN EXCLUDED.window_end ELSE c.window_end END
  WHERE c.window_end <= now() OR c.n + EXCLUDED.n <= $5
  RETURNING window_end`;
const LEFT = `SELECT greatest(1, ceil(extract(epoch FROM window_end - now())))::int AS s FROM shared_counters WHERE org_id = $1 AND key = $2`;

class Refused extends Error {
  constructor(readonly retryAfterSec: number) {
    super('refused');
  }
}

async function takeDb(pool: Pool, org: string, list: Bucket[], by: number): Promise<Taken> {
  try {
    const windows = await inOrg(pool, org, async (c) => {
      const out: Array<readonly [string, number]> = [];
      for (const b of list) {
        const r = await c.query<{ window_end: Date }>(UPSERT, [org, b.key, by, b.windowMs, b.limit]);
        if (!r.rows.length) {
          const left = await c.query<{ s: number }>(LEFT, [org, b.key]);
          throw new Refused(left.rows[0]?.s ?? secs(b.windowMs));
        }
        out.push([b.key, r.rows[0].window_end.getTime()]);
      }
      return out;
    });
    return { ok: true, windows };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, retryAfterSec: err.retryAfterSec };
    throw err;
  }
}

function takeMem(org: string, list: Bucket[], by: number): Taken {
  const t = now();
  const next: Array<{ id: string; n: number; end: number }> = [];
  for (const b of list) {
    const id = org + '\0' + b.key;
    const e = mem.get(id);
    if (!e || e.end <= t) next.push({ id, n: by, end: t + b.windowMs });
    else if (e.n + by <= b.limit) next.push({ id, n: e.n + by, end: e.end });
    else return { ok: false, retryAfterSec: secs(e.end - t) };
  }
  for (const x of next) {
    mem.delete(x.id); // re-insert: Map order is the LRU order
    mem.set(x.id, { n: x.n, end: x.end });
  }
  while (mem.size > MEMORY_KEYS) mem.delete(mem.keys().next().value as string);
  return { ok: true, windows: next.map((x, i) => [list[i].key, x.end] as const) };
}

/** Test hooks: forget the memory store, and its clock. */
export function resetMemoryForTest(clock?: () => number): void {
  mem.clear();
  now = clock ?? (() => Date.now());
}

/** Test hook: forget `org`'s keys starting with `prefix`, in memory and (when wired) in Postgres. */
export async function forgetForTest(org: string, prefix: string): Promise<void> {
  for (const id of mem.keys()) if (id.startsWith(org + '\0' + prefix)) mem.delete(id);
  if (db) await inOrg(db, org, (c) => c.query("DELETE FROM shared_counters WHERE org_id = $1 AND starts_with(key, $2)", [org, prefix]));
}
