// Stored images: logos and Image-card pictures, as rows of `blobs` on a server
// with DATABASE_URL (0018_blobs.sql). MAIN.
//
// fs-shaped, like recordFs: callers pass the file path they always built under
// userData, and the row key is that path relative to the org's userData. Two
// families only, each with its cap:
//
//   branding/logo.<png|svg>, branding/dash-<uuid>.<png|svg>   512 KiB
//   projects/<uuid>/assets/<uuid>.<png|jpg|svg>               5 MiB
//
//   desktop / plain-Node checks (no serverDataDir)  → the file, unchanged.
//   server without DATABASE_URL                     → the file, whitelist and caps enforced.
//   server with DATABASE_URL                        → the row; nothing is written to disk.
//
// Content is the OWNER's check (branding.validateLogo, projectAssets.validAsset)
// on every read: there is no mime column. A file an earlier version left on this
// pod's disk becomes the row on its first read and stays on disk, for a rollback;
// removeBlob deletes both. Errors never name a path: bundle.ts shows them.

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import type { Pool, QueryResult } from 'pg';
import * as appPaths from './paths';
import { ctx, serverDataDir } from '../server/context';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const LOGO = new RegExp(`^branding/(?:logo|dash-${UUID})\\.(?:png|svg)$`);
const ASSET = new RegExp(`^projects/${UUID}/assets/${UUID}\\.(?:png|jpg|svg)$`);
const LOGO_CAP = 512 * 1024; // branding.LOGO_MAX_BYTES
const ASSET_CAP = 5 * 1024 * 1024; // projectAssets.MAX_ASSET_BYTES
const NOT_IMAGE = 'Not a stored image path.';
const TOO_BIG = 'That image is over the size limit for its kind.';
const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Is `rel` ('/'-separated, relative to userData) a stored image? */
export function isBlobPath(rel: string): boolean {
  return LOGO.test(rel) || ASSET.test(rel);
}

/** The byte cap for `rel`, or null when it is not a stored image. */
export function capOf(rel: string): number | null {
  return LOGO.test(rel) ? LOGO_CAP : ASSET.test(rel) ? ASSET_CAP : null;
}

let db: Pool | null = null;

/** Store images in Postgres (server with DATABASE_URL, after migrations), or back to files with null. */
export function useBlobDb(pool: Pool | null): void {
  db = pool;
}

function relOf(p: string): string | null {
  const rel = path.relative(appPaths.userData(), path.resolve(p));
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
}

interface At { org: string; rel: string; pool: Pool }

/** Where `rel` lives in the DB, or null: DB off, or not a server. */
function dbAt(rel: string): At | null {
  if (!db || serverDataDir() === null) return null;
  const org = ctx().org.id;
  if (!ORG_RE.test(org)) throw new Error('invalid org id');
  return { org, rel, pool: db };
}

/** Server mode: the checked key for `p` (throws on a path or size we do not store), and its row when the DB is on. Null on the desktop. */
function at(p: string, size = 0): { rel: string; db: At | null } | null {
  if (serverDataDir() === null) return null;
  const rel = relOf(p);
  const cap = rel === null ? null : capOf(rel);
  if (rel === null || cap === null) throw new Error(NOT_IMAGE);
  if (size > cap) throw new Error(TOO_BIG);
  return { rel, db: dbAt(rel) };
}

/** One statement for `a.org`, in a transaction that sets the RLS org. `$1` is always the org. (recordFs.ts's.) */
async function sql(a: At, text: string, params: unknown[] = []): Promise<QueryResult> {
  const c = await a.pool.connect();
  let broken: Error | undefined;
  try {
    // a.org passed ORG_RE above: it cannot close this literal.
    await c.query(`BEGIN; SELECT set_config('ordinate.org', '${a.org}', true)`);
    const r = await c.query(text, [a.org, ...params]);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch((e: Error) => { broken = e; });
    throw err;
  } finally {
    c.release(broken);
  }
}

// [lo, hi): every path under directory `rel`. '0' is the character after '/'.
function under(rel: string): [string, string] {
  return [rel + '/', rel + '0'];
}

const disk = (p: string): Promise<Buffer | null> => fs.promises.readFile(p).catch(() => null);

/** The stored bytes, or null: none, not a stored image, or a legacy file over its cap. */
export async function readBlob(p: string): Promise<Buffer | null> {
  let a: ReturnType<typeof at>;
  try { a = at(p); } catch { return null; }
  if (!a || !a.db) return disk(p);
  const sel = 'SELECT bytes FROM blobs WHERE org_id = $1 AND path = $2';
  const row = (await sql(a.db, sel, [a.rel])).rows[0];
  if (row) return row.bytes as Buffer;
  // No row: a file an earlier version left on this pod's disk becomes it. Two
  // pods may seed at once — the first row wins and both serve it.
  const legacy = await disk(p);
  if (!legacy) return null;
  if (legacy.length > capOf(a.rel)!) {
    console.warn('[blobs] a stored image is over its size limit and is not served:', a.rel);
    return null;
  }
  await sql(a.db, 'INSERT INTO blobs (org_id, path, bytes) VALUES ($1, $2, $3) ON CONFLICT (org_id, path) DO NOTHING', [a.rel, legacy]);
  return ((await sql(a.db, sel, [a.rel])).rows[0]?.bytes as Buffer | undefined) ?? null;
}

/** Insert or replace. Throws on a path or size the server does not store. */
export async function writeBlob(p: string, buf: Buffer): Promise<void> {
  const a = at(p, buf.length);
  if (a?.db) {
    await sql(a.db, `INSERT INTO blobs (org_id, path, bytes) VALUES ($1, $2, $3)
      ON CONFLICT (org_id, path) DO UPDATE SET bytes = EXCLUDED.bytes, updated_at = now()`, [a.rel, buf]);
    return;
  }
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, p);
}

/** The row and this pod's file, so a legacy copy cannot come back. */
export async function removeBlob(p: string): Promise<void> {
  let a: ReturnType<typeof at>;
  try { a = at(p); } catch { return; }
  if (a?.db) await sql(a.db, 'DELETE FROM blobs WHERE org_id = $1 AND path = $2', [a.rel]);
  await fs.promises.rm(p, { force: true });
}

/** Every row under directory `dir` (a deleted project's pictures). Never touches disk: the caller removed the folder. */
export async function removeBlobsUnder(dir: string): Promise<number> {
  const rel = relOf(dir);
  const a = rel ? dbAt(rel) : null;
  if (!a) return 0;
  const [lo, hi] = under(a.rel);
  return (await sql(a, 'DELETE FROM blobs WHERE org_id = $1 AND path >= $2 AND path < $3', [lo, hi])).rowCount ?? 0;
}

/** File names directly under `dir`: the rows and the stored-image files on this disk, sorted. */
export async function listBlobs(dir: string): Promise<string[]> {
  const rel = relOf(dir);
  if (rel === null) return [];
  const names = new Set<string>();
  for (const n of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    if (serverDataDir() === null || isBlobPath(`${rel}/${n}`)) names.add(n);
  }
  const a = dbAt(rel);
  if (a) {
    const [lo, hi] = under(rel);
    for (const row of (await sql(a, 'SELECT path FROM blobs WHERE org_id = $1 AND path >= $2 AND path < $3', [lo, hi])).rows) {
      const n = (row.path as string).slice(lo.length);
      if (!n.includes('/')) names.add(n);
    }
  }
  return [...names].sort();
}
