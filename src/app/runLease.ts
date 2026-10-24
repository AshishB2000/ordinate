// One-at-a-time work across pods, held as a LEASE RECORD rather than a
// connection (docs/any-pod/00-design.md §3.9, §3.12): a project's pipeline run,
// the org's sample seed. Nothing holds a pooled Postgres client while the work
// runs — a session advisory lock did, for as long as a pipeline retried a node.
//
//   claim    one short recordFs.locked hold: the lease is free (none, or its
//            `until` has passed on the DATABASE clock) → write { claim, until }
//   renew    every HEARTBEAT_MS while the work runs, only while still ours
//   release  one short hold that deletes the lease, only if still ours
//
// A pod that dies mid-run stops renewing; the lease frees itself LEASE_MS
// later. Without a database there is one pod: the record is a file and the
// clock is this pod's.

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';
import * as recordFs from './recordFs';

export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 30_000;

let db: Pool | null = null;

/** The database clock (server with DATABASE_URL), or this pod's with null. */
export function useLeaseDb(pool: Pool | null): void {
  db = pool;
}

/** Now, in epoch ms, on the database's clock when there is one. */
export async function dbNow(): Promise<number> {
  if (!db) return Date.now();
  const r = await db.query<{ t: number }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS t');
  return Number(r.rows[0].t);
}

interface Lease { v: 1; claim: string; until: number }

async function read(file: string): Promise<Lease | null> {
  try {
    const l = JSON.parse(await recordFs.readFile(file, 'utf8')) as Partial<Lease>;
    return l && l.v === 1 && typeof l.claim === 'string' && typeof l.until === 'number' ? (l as Lease) : null;
  } catch {
    return null;
  }
}

async function write(file: string, lease: Lease): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await recordFs.writeFile(tmp, JSON.stringify(lease));
  await recordFs.rename(tmp, file);
}

/** Takes the lease at `file` for a new claim; the claim id, or null while someone else's lease is live. */
export async function claim(file: string): Promise<string | null> {
  const id = randomUUID();
  return recordFs.locked(file, async () => {
    const cur = await read(file);
    const now = await dbNow();
    if (cur && cur.until >= now) return null;
    await write(file, { v: 1, claim: id, until: now + LEASE_MS });
    return id;
  });
}

/** Moves the lease on, only while it is still `id`'s. */
export async function renew(file: string, id: string): Promise<boolean> {
  return recordFs.locked(file, async () => {
    const cur = await read(file);
    if (!cur || cur.claim !== id) return false;
    await write(file, { v: 1, claim: id, until: (await dbNow()) + LEASE_MS });
    return true;
  });
}

/** Lets the lease go, only if it is still `id`'s. */
export async function release(file: string, id: string): Promise<void> {
  await recordFs.locked(file, async () => {
    const cur = await read(file);
    if (cur && cur.claim === id) await recordFs.rm(file, { force: true });
  });
}

/**
 * Runs `fn` holding the lease at `file`, renewed while it runs and released after (on every path),
 * or returns `{ ran: false }` without running it while another holder's lease is live.
 */
export async function withLease<T>(file: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const id = await claim(file);
  if (!id) return { ran: false };
  const beat = setInterval(() => { void renew(file, id).catch(() => undefined); }, HEARTBEAT_MS);
  beat.unref();
  try {
    return { ran: true, value: await fn() };
  } finally {
    clearInterval(beat);
    await release(file, id).catch(() => undefined); // an unreleased lease frees itself LEASE_MS later
  }
}

/** `withLease`, retried every 250 ms for up to `waitMs` while another holder has it. */
export async function waitForLease<T>(file: string, fn: () => Promise<T>, waitMs: number): Promise<{ ran: true; value: T } | { ran: false }> {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await withLease(file, fn);
    if (r.ran || Date.now() >= until) return r;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
