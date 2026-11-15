// Whether meaning search can run here: pgvector in this database, and the fingerprint table (0029_pgvector.sql).
// For Admin → AI and the search (PR 7b; nothing reads it yet). Without either, search is words only.
//
// The table comes from `ordinate_ensure_vector_store()`, the function 0029 defines and calls: where the extension was
// created after the upgrade, the first status check here makes the table, with the same DDL. Nothing here creates the
// extension: that is the migration's, or the operator's.
//
// Cached per pod for STATUS_TTL_MS, by pool, not by orgKey(): it is a fact about the database every org shares, and
// holds no org's data. A different pool (a test's scratch database) is a different entry.

import type { Pool } from 'pg';
import { orgDb } from './db/inOrg';

/**
 * Why there is no meaning search: no_database (no DATABASE_URL); no_extension (the Postgres server has no pgvector);
 * not_created (it has pgvector, but this database does not: the migration's role could not create it, or it was
 * installed after the upgrade, so an operator runs CREATE EXTENSION vector); no_table (the extension is there, the
 * table could not be made: a pgvector before 0.5, or no CREATE on the schema).
 */
export type VectorReason = 'no_database' | 'no_extension' | 'not_created' | 'no_table';

export interface VectorStatus {
  /** pgvector is created in this database. */
  readonly available: boolean;
  /** `assistant_search_vectors` exists. */
  readonly table: boolean;
  readonly reason?: VectorReason;
}

const STATUS_TTL_MS = 30_000;
let cached: { pool: Pool; at: number; status: VectorStatus } | null = null;

/** Makes the table where the extension exists and it does not; true when the table is there. Never creates the extension. */
export async function ensureVectorStore(pool: Pool | null = orgDb()): Promise<boolean> {
  if (!pool) return false;
  const r = await pool.query<{ ok: boolean }>('SELECT ordinate_ensure_vector_store() AS ok');
  return r.rows[0].ok;
}

async function read(pool: Pool): Promise<{ offered: boolean; available: boolean; table: boolean }> {
  const r = await pool.query<{ offered: boolean; available: boolean; has_table: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS offered,
            EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS available,
            to_regclass('assistant_search_vectors') IS NOT NULL AS has_table`,
  );
  const { offered, available, has_table: table } = r.rows[0];
  return { offered, available, table };
}

/** pgvector and the fingerprint table, as of at most `maxAgeMs` ago. */
export async function vectorStatus(maxAgeMs: number = STATUS_TTL_MS): Promise<VectorStatus> {
  const pool = orgDb();
  if (!pool) return { available: false, table: false, reason: 'no_database' };
  if (cached && cached.pool === pool && Date.now() - cached.at < maxAgeMs) return cached.status;
  let s = await read(pool);
  if (s.available && !s.table && (await ensureVectorStore(pool))) s = { ...s, table: true };
  const status: VectorStatus = s.table
    ? { available: true, table: true }
    : { available: s.available, table: false, reason: s.available ? 'no_table' : s.offered ? 'not_created' : 'no_extension' };
  cached = { pool, at: Date.now(), status };
  return status;
}
