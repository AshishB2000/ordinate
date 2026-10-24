// The org's STAGING AREA: where an upload's bytes, a download's bytes and a
// staged import's Parquet wait between the request that made them and the one
// that uses them — on whichever pod that lands (docs/any-pod/00-design.md §3.2).
//
//   file mode   DATA_DIR/orgs/<org>/temp/<name> — DATA_DIR is the shared volume
//               more than one pod already needs for its tables.
//   S3 mode     <prefix>/orgs/<org>/staging/<name> in the bucket; a pod reads it
//               into its own DATA_DIR/orgs/<org>/temp/ (an emptyDir) to use it.
//
// A PLACE is { org, name }, captured once — at upload, at offer, at take — from
// ctx(); everything after (a download's `close`, `done()`, the sweep) uses the
// captured place and never calls ctx(), which throws outside a request.
// THE WALLS: `org` passes ORG_RE and `name` is a server-made file name with no
// separator, so a place can only ever be inside its own org's directory or
// prefix. Every row that names a place also names its org, and each store's
// statements filter on it (and RLS forces it).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import type { Pool } from 'pg';
import { ctx, serverDataDir } from './context';
import { inOrg } from './db/orgTx';
import * as s3 from '../engine/s3';
import { orgKey, orgUrl, s3Config } from '../engine/storage';

const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** `upload-<32 hex>`, `stage-<uuid>.parquet`, `export-<uuid>.ordinate`, `fetched-<uuid>`, … */
const NAME_RE = /^[a-z]+-[0-9a-f-]{32,36}(\.[a-z]{2,8})?$/;

export interface Place {
  readonly org: string;
  readonly name: string;
}

/** `name` checked, or a throw: it becomes a path segment and an S3 key segment. */
export function checkName(name: string): string {
  if (!NAME_RE.test(name)) throw new Error('staging: invalid name');
  return name;
}

/** A place in `org`'s staging area (an org id read from a row is checked like ctx's). */
export function placeIn(org: string, name: string): Place {
  if (!ORG_RE.test(org)) throw new Error('staging: invalid org id');
  return { org, name: checkName(name) };
}

/** A place in the CALLER's org — at take or offer time, inside the request. */
export function here(name: string): Place {
  return placeIn(ctx().org.id, name);
}

export const isS3 = (): boolean => s3Config() !== null;

/** This pod's org temp directory for `org` (created), without ctx. */
export function tempDir(org: string): string {
  const root = serverDataDir();
  if (root === null || !ORG_RE.test(org)) throw new Error('staging: not on a server');
  const dir = path.join(root, 'orgs', org, 'temp');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The place's file on this pod: in file mode THE bytes (on the shared volume); on S3 only where a local copy would be. */
export function localPath(p: Place): string {
  return path.join(tempDir(p.org), p.name);
}

function need(): import('./env').S3Env {
  const cfg = s3Config();
  if (!cfg) throw new Error('staging: S3 is not configured');
  return cfg;
}

/** Bucket-relative key of a place. */
export function s3Key(p: Place): string {
  return orgKey(need(), p.org) + 'staging/' + p.name;
}

/** Where DuckDB writes or reads a staged Parquet file: the s3:// URL (inside the org worker's secret scope), or the local file. */
export function parquetTarget(p: Place): string {
  return isS3() ? orgUrl(need(), p.org) + 'staging/' + p.name : localPath(p);
}

/** Make `localFile` (this pod's, sha256 hex, `size` bytes) the place's bytes. File mode: it already is. */
export async function publish(p: Place, localFile: string, sha256: string, size: number): Promise<void> {
  if (!isS3()) return;
  await s3.put(need(), s3Key(p), localFile, sha256, size);
}

/** A NEW local file holding the place's bytes (S3: fetched; written to a temp sibling, then renamed). File mode: the shared file itself. */
export async function fetchLocal(p: Place): Promise<{ file: string; own: boolean }> {
  if (!isS3()) return { file: localPath(p), own: false };
  const file = path.join(tempDir(p.org), `fetched-${randomUUID()}`);
  await s3.download(need(), s3Key(p), file);
  return { file, own: true };
}

/** The place's bytes as a stream, and their size. Throws when they are gone. */
export async function openStream(p: Place): Promise<{ body: Readable; size: number }> {
  if (isS3()) return s3.open(need(), s3Key(p));
  const file = localPath(p);
  const { size } = await fs.promises.stat(file);
  return { body: fs.createReadStream(file), size };
}

/** Deletes the place's bytes. A missing one is success. */
export async function remove(p: Place): Promise<void> {
  if (isS3()) await s3.remove(need(), s3Key(p));
  else await fs.promises.rm(localPath(p), { force: true });
}

/**
 * One sweep of an org's due rows (the `shared:sweep` job): `due` selects `(k, storage_key)` for org
 * $1; each row's bytes are deleted, then `drop` deletes the row by org $1 and `k` $2. A failed
 * delete keeps its row for the next pass. File tokens and staged imports both sweep through this.
 */
export async function sweepRows(p: Pool, org: string, due: string, drop: string): Promise<string[]> {
  const rows = await inOrg(p, org, (c) => c.query<{ k: unknown; storage_key: string }>(due, [org]));
  const gone: string[] = [];
  for (const row of rows.rows) {
    try {
      await remove(placeIn(org, row.storage_key));
    } catch {
      continue;
    }
    await inOrg(p, org, (c) => c.query(drop, [org, row.k]));
    gone.push(String(row.k));
  }
  return gone;
}
