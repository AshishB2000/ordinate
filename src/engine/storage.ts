// Where a dataset's Parquet lives on the server — SERVER ONLY (T5.2).
//
// STORAGE_URL unset or file:// → nothing here is on: the table is
// `<userData>/projects/<p>/datasets/<id>.parquet`, written temp-then-rename,
// exactly as on the desktop.
//
// STORAGE_URL=s3://bucket/prefix → a table is an IMMUTABLE object
//
//   s3://bucket/prefix/orgs/<org>/<project>/<id>.<version>.parquet   (+ .source.parquet)
//
// and the dataset record (a Postgres row since T5.1) carries `storageVersion`.
//
// WRITE (datasets.persistNow): a fresh version → its keys registered in
// `storage_objects` (0009) → DuckDB COPYs each table straight to S3 from the
// org's worker (one PUT, or a multipart upload that only appears when it
// completes) → the record is written with the new `storageVersion` — ONE
// upsert. That upsert is the switch: a reader resolves the pointer per call,
// so it sees the old version or the new one, never a half-written file. It
// replaces temp-then-rename, which S3 does not have.
//
// READ (`readPath`): the record's version → the local cache's copy if this pod
// has it, else the s3:// URL (read by httpfs in the org worker) while the
// object's exact bytes are fetched into the cache in the background.
//
// ISOLATION: each org worker (src/engine/duckdbPool.ts) holds ONE secret scoped
// to `s3://bucket/prefix/orgs/<org>/` and that prefix in allowed_directories —
// another org's prefix is refused inside DuckDB (scripts/test-storageS3.ts).
//
// GC (`collectGarbage`, the `storage:gc` job): a version no record mentions —
// live, trashed, anything in the org — is stamped `unreferenced_since`; one
// still unreferenced a grace period (STORAGE_GC_GRACE_MINUTES) after that is
// deleted. The grace runs from when it STOPPED being pointed at, not from when
// it was written, so a reader that resolved the old pointer just before a
// switch finishes long before its file goes. A version is never pointed at
// again once nothing names it (every pointer is a fresh UUID).

import * as path from 'path';
import type { Pool } from 'pg';
import type { S3Env } from '../server/env';
import { ctx } from '../server/context';
import * as cache from './parquetCache';
import * as s3 from './s3';

let cfg: S3Env | null = null;
let dataDir = '';
let db: Pool | null = null;

// Same rule as src/app/paths.ts: an org id becomes a key segment and a SQL literal.
const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server boot: S3 on (with the cache) or off (null). */
export function configure(dir: string, s3cfg: S3Env | null, cacheBytes: number): void {
  cfg = s3cfg;
  dataDir = dir;
  if (cfg) cache.configure(dir, cacheBytes);
}

/** The Postgres pool `storage_objects` lives in (set once migrations ran), or null. */
export function useStorageDb(pool: Pool | null): void {
  db = pool;
}

export function isS3(): boolean {
  return cfg !== null;
}

function org(): string {
  const id = ctx().org.id;
  if (!ORG_RE.test(id)) throw new Error('invalid org id');
  return id;
}

/** `prefix/orgs/<org>/` — bucket-relative. */
function orgKey(s: S3Env, orgId: string): string {
  return `${s.prefix ? s.prefix + '/' : ''}orgs/${orgId}/`;
}

/** `s3://bucket/prefix/orgs/<org>/` — the one prefix an org's worker may read. */
export function orgUrl(s: S3Env, orgId: string): string {
  return `s3://${s.bucket}/${orgKey(s, orgId)}`;
}

/** The object of one table version, relative to the org prefix. Every part is a validated id. */
function relKey(projectId: string, id: string, version: string, source: boolean): string {
  if (![projectId, id, version].every((x) => UUID_RE.test(x))) throw new Error('storage: invalid id');
  return `${projectId}/${id}.${version}${source ? '.source' : ''}.parquet`;
}

const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * Statements for an org worker, BEFORE its lock (duckdbPool.lockedSetup): load
 * the extensions (installed in the image, never at runtime) and, for an org,
 * its one scoped secret. `REFRESH auto` re-resolves expiring role credentials.
 */
export function workerSetup(s: S3Env, orgId: string | null): string[] {
  const out = [
    ...(s.extensionDir ? [`SET extension_directory=${sqlStr(s.extensionDir)};`] : []),
    'SET autoinstall_known_extensions=false;',
    'SET autoload_known_extensions=false;',
    'LOAD httpfs;',
    'LOAD aws;',
  ];
  if (orgId === null) return out;
  if (!ORG_RE.test(orgId)) throw new Error('invalid org id');
  const endpoint = s.endpoint ? `, ENDPOINT ${sqlStr(s.endpoint)}, URL_STYLE 'path', USE_SSL ${s.useSsl}` : '';
  out.push(
    `CREATE SECRET ordinate_org (TYPE s3, PROVIDER credential_chain, REFRESH auto, REGION ${sqlStr(s.region)}${endpoint}, ` +
      `SCOPE ${sqlStr(orgUrl(s, orgId))});`,
  );
  return out;
}

/**
 * A new object for one table version of the caller's org: registered in
 * `storage_objects` FIRST (so GC knows it even if the write dies halfway),
 * returned as the s3:// URL DuckDB COPYs to.
 */
export async function newObject(projectId: string, id: string, version: string, source: boolean): Promise<string> {
  const s = need();
  const o = org();
  const rel = relKey(projectId, id, version, source);
  await inOrg(o, (c) => c.query('INSERT INTO storage_objects (org_id, key, version) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [o, rel, version]));
  return orgUrl(s, o) + rel;
}

/** Where to READ one table version now: the cached copy, or the s3:// URL (and start caching it). */
export function readPath(projectId: string, id: string, version: string, source: boolean): string {
  const s = need();
  const o = org();
  const rel = relKey(projectId, id, version, source);
  const local = path.join(cache.dirFor(dataDir, o), rel.replace('/', '.'));
  if (cache.has(local)) return local;
  void cache.fill(local, (file) => s3.download(s, orgKey(s, o) + rel, file));
  return orgUrl(s, o) + rel;
}

/**
 * One GC pass for the caller's org (the `storage:gc` job). Returns the keys it
 * deleted. A key whose S3 delete fails stays registered and is retried next pass.
 */
export async function collectGarbage(graceMs: number): Promise<string[]> {
  const s = need();
  const o = org();
  // Every version named by ANY record of the org — live, trashed, versioned.
  // ponytail: a regex over every record body per pass; an indexed pointer column when that is slow.
  const due = await inOrg(o, (c) => c.query(
    `WITH refs AS (
       SELECT DISTINCT (regexp_matches(body, '"storageVersion": *"([0-9a-fA-F-]{36})"', 'g'))[1]::uuid AS v
         FROM records WHERE org_id = $1 AND strpos(body, '"storageVersion"') > 0)
     UPDATE storage_objects o
        SET unreferenced_since = CASE WHEN o.version IN (SELECT v FROM refs) THEN NULL ELSE coalesce(o.unreferenced_since, now()) END
      WHERE o.org_id = $1
     RETURNING o.key, o.unreferenced_since < now() - $2 * interval '1 millisecond' AS due`,
    [o, graceMs],
  ));
  const deleted: string[] = [];
  for (const row of due.rows as Array<{ key: string; due: boolean }>) {
    if (!row.due) continue;
    try {
      await s3.remove(s, orgKey(s, o) + row.key);
    } catch {
      continue;
    }
    cache.drop(path.join(cache.dirFor(dataDir, o), row.key.replace('/', '.')));
    await inOrg(o, (c) => c.query('DELETE FROM storage_objects WHERE org_id = $1 AND key = $2', [o, row.key]));
    deleted.push(row.key);
  }
  return deleted;
}

function need(): S3Env {
  if (!cfg) throw new Error('storage: S3 is not configured');
  return cfg;
}

/** One statement in a transaction that sets the RLS org (as src/app/recordFs.ts). */
async function inOrg<T>(o: string, fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  if (!db) throw new Error('storage: no database');
  const c = await db.connect();
  try {
    // o passed ORG_RE: it cannot close this literal.
    await c.query(`BEGIN; SELECT set_config('ordinate.org', '${o}', true)`);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
