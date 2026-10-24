// Staged imports that ANY pod can save (0021 `import_stages`; docs/any-pod/00-design.md §3.4)
// — the Postgres half of ./importStage.ts.
//
// A stage is a ROW (owner, the parse's metadata, 30-minute expiry) and a PARQUET
// file in the org's staging area (src/server/staging.ts), written once with a
// DuckDB COPY and every cell tagged exactly (./stageCodec.ts). The row is the
// truth: a stage another pod saved (and dropped) is gone here too, even when
// this pod still holds its rows in memory.
//
//   put   the row FIRST, not ready (a pod dying mid-COPY leaves a row the
//         sweep cleans up), then the Parquet, then the row READY, then evict
//         the owner's READY stages past the newest MAX_STAGED — never one still
//         being written, so an eviction never leaves a file no row names, and
//         never the caller's own. A failed COPY deletes its row.
//   get   the caller's live row, then this pod's memory copy or the Parquet
//         (the first `limit` rows only, for a preview).
//   drop  the row, then the bytes and the memory copy.
//
// The same-pod MEMORY copy is a fast path for tables up to STAGE_MEMORY_CELLS,
// with a pod-wide LRU budget: a 1M-row parse leaves the heap once written.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { ctx } from '../server/context';
import { inOrg } from '../server/db/orgTx';
import * as staging from '../server/staging';
import * as parquetStore from '../engine/parquetStore';
import { checkCells, decodeRows, encodeCell } from './stageCodec';
import type { ParseResult } from './parse';

export const MAX_STAGED = 2;
export const TTL_MS = 30 * 60 * 1000;
/** A table is kept in this pod's memory too only up to this many cells (rows × columns). */
export const STAGE_MEMORY_CELLS = 250_000;
/** …and this many across every owner, oldest first out — its Parquet stays. */
export const STAGE_MEMORY_POD_CELLS = 4_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Log {
  warn(obj: object, msg: string): void;
}
let db: Pool | null = null;
let log: Log = { warn: () => undefined };

/** Stages in Postgres + staging storage through this pool, or the in-process Map (./importStage.ts) with null. */
export function useStageDb(pool: Pool | null, l?: Log): void {
  db = pool;
  if (l) log = l;
}

export function dbOn(): boolean {
  return db !== null;
}

function pool(): Pool {
  if (!db) throw new Error('import stages: no database');
  return db;
}

/** What put says when its own row was swept while it wrote (it never is, in normal operation). */
export const STAGE_LOST = 'This import took too long to stage — bring the file in again.';

// ── This pod's memory copies ────────────────────────────────────────────────
const memory = new Map<string, { org: string; user: string; table: ParseResult; cells: number; expires: number }>();
let memoryCells = 0;
const cellsOf = (t: ParseResult): number => t.rows.length * Math.max(1, t.columns.length);

function remember(id: string, org: string, user: string, table: ParseResult): void {
  pruneMemory();
  const cells = cellsOf(table);
  if (cells > STAGE_MEMORY_CELLS) return;
  memory.set(id, { org, user, table, cells, expires: Date.now() + TTL_MS });
  memoryCells += cells;
  while (memoryCells > STAGE_MEMORY_POD_CELLS && memory.size) forget(memory.keys().next().value as string);
}

/** Drops memory copies past their stage's TTL — a stage nobody saves must not stay in the heap (also run by the 60 s files timer). */
export function pruneMemory(now = Date.now()): void {
  for (const [id, m] of memory) if (now >= m.expires) forget(id);
}

function forget(id: string): void {
  const m = memory.get(id);
  if (!m) return;
  memory.delete(id);
  memoryCells -= m.cells;
}

const placeOf = (org: string, key: string): staging.Place => staging.placeIn(org, key);
const removeBytes = (p: staging.Place): Promise<void> =>
  staging.remove(p).catch((err: unknown) => log.warn({ err }, 'import stage: its file could not be deleted; the sweep will'));

/** Stages a parsed table for the caller; the id the browser refers to it by. */
export async function put(table: ParseResult): Promise<string> {
  checkCells(table.rows);
  const { org, user } = ctx();
  const id = randomUUID();
  const place = staging.here(`stage-${id}.parquet`);
  const { rows: _rows, ...rest } = table;
  const meta = JSON.stringify({ v: 1, table: rest });
  await inOrg(pool(), org.id, (c) => c.query(
    `INSERT INTO import_stages (id, org_id, user_email, storage_key, meta, expires_at) VALUES ($2, $1, $3, $4, $5, now() + $6 * interval '1 millisecond')`,
    [org.id, id, user.email, place.name, meta, TTL_MS],
  ));
  try {
    await parquetStore.writeTableAsync(staging.parquetTarget(place), table.columns, table.rows, { stageDir: staging.tempDir(org.id), encodeCell });
  } catch (err) {
    await inOrg(pool(), org.id, (c) => c.query('DELETE FROM import_stages WHERE org_id = $1 AND id = $2', [org.id, id]))
      .catch((e: unknown) => log.warn({ err: e }, 'import stage: a row could not be deleted after its write failed'));
    await removeBytes(place);
    throw err;
  }
  const ready = await inOrg(pool(), org.id, (c) => c.query(
    'UPDATE import_stages SET ready_at = clock_timestamp() WHERE org_id = $1 AND id = $2 RETURNING id', [org.id, id]));
  if (!ready.rows.length) {
    await removeBytes(place); // the row went while we wrote: nothing may name these bytes now
    throw new Error(STAGE_LOST);
  }
  // Only READY stages are evicted, newest-ready kept — this one (just made ready) always is.
  const evicted = await inOrg(pool(), org.id, (c) => c.query<{ id: string; storage_key: string }>(
    `DELETE FROM import_stages WHERE org_id = $1 AND id IN (
       SELECT id FROM import_stages WHERE org_id = $1 AND user_email = $2 AND ready_at IS NOT NULL ORDER BY ready_at DESC OFFSET $3)
     RETURNING id, storage_key`,
    [org.id, user.email, MAX_STAGED],
  ));
  for (const e of evicted.rows) {
    forget(e.id);
    await removeBytes(placeOf(org.id, e.storage_key));
  }
  remember(id, org.id, user.email, table);
  return id;
}

/** The caller's own staged table — all of it, or its first `limit` rows (rowCount stays the whole). Null when gone or not theirs. */
export async function get(id: unknown, limit?: number): Promise<ParseResult | null> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  const { org, user } = ctx();
  const r = await inOrg(pool(), org.id, (c) => c.query<{ storage_key: string; meta: string }>(
    'SELECT storage_key, meta FROM import_stages WHERE org_id = $1 AND id = $2 AND user_email = $3 AND ready_at IS NOT NULL AND expires_at > now()',
    [org.id, id, user.email],
  ));
  const row = r.rows[0];
  if (!row) {
    forget(id);
    return null;
  }
  const rest = (JSON.parse(row.meta) as { table: Omit<ParseResult, 'rows'> }).table;
  pruneMemory();
  const m = memory.get(id);
  if (m && m.org === org.id && m.user === user.email) {
    memory.delete(id); // touch: most recently used last
    memory.set(id, m);
    return limit === undefined ? m.table : { ...m.table, rows: m.table.rows.slice(0, limit) };
  }
  const read = await parquetStore.readTableAsync(staging.parquetTarget(placeOf(org.id, row.storage_key)), undefined, limit);
  if (!read) return null;
  return { ...rest, rows: decodeRows(read.rows) } as ParseResult;
}

/** Drops the caller's own staged table (a save took it). */
export async function drop(id: unknown): Promise<void> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return;
  const { org, user } = ctx();
  const r = await inOrg(pool(), org.id, (c) => c.query<{ storage_key: string }>(
    'DELETE FROM import_stages WHERE org_id = $1 AND id = $2 AND user_email = $3 RETURNING storage_key',
    [org.id, id, user.email],
  ));
  forget(id);
  for (const row of r.rows) await removeBytes(placeOf(org.id, row.storage_key));
}

/**
 * One sweep for `org` (the `shared:sweep` job): stages expired 10 minutes ago — the bytes, then the
 * row (staging `sweepRows`). Then, in file mode, the backstop for a crash between a write and its
 * row: a `stage-*.parquet` in the org's temp that no row names, older than the TTL, is deleted (on
 * S3 the bucket's lifecycle rule is the backstop).
 */
export async function sweep(p: Pool, org: string): Promise<number> {
  const gone = await staging.sweepRows(p, org,
    `SELECT id AS k, storage_key FROM import_stages WHERE org_id = $1 AND expires_at < now() - interval '10 minutes'`,
    'DELETE FROM import_stages WHERE org_id = $1 AND id = $2');
  for (const id of gone) forget(id);
  if (staging.isS3()) return gone.length;
  const dir = staging.tempDir(org);
  const files = (await fs.promises.readdir(dir)).map((n) => ({ n, id: /^stage-([0-9a-f-]{36})\.parquet$/.exec(n)?.[1] })).filter((f): f is { n: string; id: string } => !!f.id);
  if (!files.length) return gone.length;
  const named = await inOrg(p, org, (c) => c.query<{ id: string }>('SELECT id FROM import_stages WHERE org_id = $1 AND id = ANY($2::uuid[])', [org, files.map((f) => f.id)]));
  const known = new Set(named.rows.map((r) => r.id));
  const before = Date.now() - TTL_MS;
  for (const f of files) {
    if (known.has(f.id)) continue;
    const file = path.join(dir, f.n);
    const st = await fs.promises.stat(file).catch(() => null);
    if (st && st.mtimeMs < before) await fs.promises.rm(file, { force: true }).catch(() => undefined);
  }
  return gone.length;
}

/** Test hooks. */
export function memoryForTest(): { size: number; cells: number } {
  return { size: memory.size, cells: memoryCells };
}
export function forgetMemoryForTest(): void {
  memory.clear();
  memoryCells = 0;
}
