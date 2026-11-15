// Whether meaning search can run here: pgvector in this database, and the fingerprint table (0029_pgvector.sql).
// For Admin → AI, the fingerprint job and the search (PR 7c). Without either, search is words only.
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
/** Where the extension's type and cosine-distance operator are: its schema, which an operator may have put off the search_path. */
export interface VectorPlace { readonly type: string; readonly op: string }
let cached: { pool: Pool; at: number; status: VectorStatus; place: VectorPlace | null } | null = null;

/** Makes the table where the extension exists and it does not; true when the table is there. Never creates the extension. */
export async function ensureVectorStore(pool: Pool | null = orgDb()): Promise<boolean> {
  if (!pool) return false;
  const r = await pool.query<{ ok: boolean }>('SELECT ordinate_ensure_vector_store() AS ok');
  return r.rows[0].ok;
}

async function read(pool: Pool): Promise<{ offered: boolean; available: boolean; table: boolean; schema: string | null }> {
  const r = await pool.query<{ offered: boolean; available: boolean; has_table: boolean; schema: string | null }>(
    `SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS offered,
            EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS available,
            to_regclass('assistant_search_vectors') IS NOT NULL AS has_table,
            (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector') AS schema`,
  );
  const { offered, available, has_table: table, schema } = r.rows[0];
  return { offered, available, table, schema };
}

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

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
  const place = s.table && s.schema ? { type: `${ident(s.schema)}.vector`, op: `OPERATOR(${ident(s.schema)}.<=>)` } : null;
  cached = { pool, at: Date.now(), status, place };
  return status;
}

/** The table's vector type and cosine-distance operator, schema-qualified, when the table is there (as of vectorStatus); else null. */
export async function vectorPlace(): Promise<VectorPlace | null> {
  const st = await vectorStatus();
  return st.table && cached?.pool === orgDb() ? cached.place : null;
}

/**
 * A question's fingerprint, for the nearest-items queries: the model whose rows it is compared with, as pgvector reads
 * it, and the farthest cosine distance an item may be (1 − the model's least similarity).
 */
export interface NearTo { readonly model: string; readonly literal: string; readonly place: VectorPlace; readonly maxDistance: number }

/** A vector as pgvector reads it: '[x,y,…]'. A float32 printed as a double reads back as the same float32. */
export const vectorLiteral = (v: Float32Array): string => `[${Array.from(v).join(',')}]`;
