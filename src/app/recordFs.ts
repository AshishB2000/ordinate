// Record files: the `fs.promises` subset every record store uses, with
// Postgres underneath on a server that has DATABASE_URL (T5.1). MAIN.
//
// The stores (projects, datasets metadata, visuals, analyses, metrics,
// reports, alerts, stories, scorecards, scenarios, notebooks, events,
// relationships, fx, comments, catalog, pipelines, privacy policy, copilot
// threads, publish config, connections, boundaries, versions, trash, capture
// history, themes, user templates) each read and write their JSON through
// paths under userData. That path vocabulary is the narrowest seam they share,
// so this module is a drop-in for `fs.promises.<op>` and decides per call:
//
//   desktop, or a server without DATABASE_URL   → the real file, unchanged.
//   server with DATABASE_URL, a RECORD path     → a row of `records`
//                                                 (0007_records.sql).
//   anything else (Parquet, images, salt.key)   → the real file, per-org disk.
//
// A record path is a `.json` file (or its `.json.<x>.tmp` / `.json.corrupt`
// companions) under userData/projects, userData/history, userData/templates,
// or userData/themes.json. Its row key is (org, path relative to userData).
// Not records: config.json, jobs.json and the other per-org settings files
// (config holds secrets — T5.3's store), and the modules that never touch a
// record path keep plain `fs` (Parquet, images, exports, the desktop's
// backups and sync folder).
//
// TENANCY. The org is ctx().org — the request's, never a caller's argument —
// and the path is made relative to THAT org's userData, so a path built for
// another org is simply not under it. Every statement filters `org_id = $1`,
// and runs in a transaction that `SET LOCAL ordinate.org`, which the table's
// row-level-security policy checks as well (defence in depth: it holds for a
// non-superuser role even if a query here forgot its WHERE).
//
// Atomic writes: the stores write `<file>.<uuid>.tmp` then rename it over
// `<file>`. Here the tmp is staged in memory and the rename is ONE upsert, so a
// save is one statement and a crash between the two leaves nothing behind.
//
// Directories are implicit: a directory exists when the disk has it or any
// row lives under it, and a listing is the union of both (disk Parquet beside
// DB JSON), record-shaped disk files excluded — the rows are the truth.

import * as fs from 'fs';
import * as path from 'path';
import type { Pool, QueryResult } from 'pg';
import * as appPaths from './paths';
import { ctx, serverDataDir } from '../server/context';

/** What a listing with `withFileTypes` returns — `fs.Dirent` satisfies it. */
export interface Dirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

let db: Pool | null = null;

/** Route record paths to Postgres (server with DATABASE_URL, after migrations), or back to files with null. */
export function useRecordDb(pool: Pool | null): void {
  db = pool;
}

// Same rule as src/app/paths.ts: the org id becomes a path segment there and a
// SQL literal here, so no quote, dot or separator can ever be in it.
const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ROOTS = new Set(['projects', 'history', 'templates']);
const JSON_NAME = /\.json(\.|$)/;

/** Is `rel` ('/'-separated, relative to userData) a record — a row when the DB is on? */
export function isRecordPath(rel: string): boolean {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  // `<id>.search.json` is dataSearchResident's cache of a Parquet file: it lives with the table.
  if (!JSON_NAME.test(base) || base.endsWith('.search.json')) return false;
  return parts.length === 1 ? base.startsWith('themes.json') : ROOTS.has(parts[0]);
}

const isTmp = (rel: string): boolean => rel.endsWith('.tmp');

interface At {
  org: string;
  rel: string;
  pool: Pool;
}

/** Where `p` lives in the DB, or null: DB off, desktop, or outside the org's userData. */
function at(p: string): At | null {
  const pool = db;
  if (!pool || serverDataDir() === null) return null;
  const org = ctx().org.id;
  if (!ORG_RE.test(org)) throw new Error('invalid org id');
  const rel = path.relative(appPaths.userData(), path.resolve(p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { org, rel: rel.split(path.sep).join('/'), pool };
}

/** `at(p)` when `p` is a record path, else null. */
function rec(p: string): At | null {
  const a = at(p);
  return a && isRecordPath(a.rel) ? a : null;
}

function enoent(syscall: string, p: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`);
  e.code = 'ENOENT';
  e.errno = -2;
  e.syscall = syscall;
  e.path = p;
  return e;
}

/** One statement for `a.org`, in a transaction that sets the RLS org. `$1` is always the org. */
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

// [lo, hi): every path under directory `rel` ('' = all of userData). '0' is the
// character after '/', so the range is one index scan under COLLATE "C".
function under(rel: string): [string, string] {
  return rel ? [rel + '/', rel + '0'] : ['', '\u{10FFFF}'];
}

// In-memory `.tmp` stage, keyed org + NUL + rel. ponytail: a tmp whose rename
// never comes (the writer threw between the two) stays until the process
// exits; the stores all rename or rm right after the write.
const staged = new Map<string, string>();
const keyOf = (a: At): string => a.org + '\0' + a.rel;

async function readRow(a: At): Promise<string | undefined> {
  if (isTmp(a.rel)) return staged.get(keyOf(a));
  const r = await sql(a, 'SELECT body FROM records WHERE org_id = $1 AND path = $2', [a.rel]);
  return r.rows.length ? (r.rows[0].body as string) : undefined;
}

async function writeRow(a: At, body: string): Promise<void> {
  if (isTmp(a.rel)) {
    staged.set(keyOf(a), body);
    return;
  }
  await sql(
    a,
    `INSERT INTO records (org_id, path, body) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, path) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
    [a.rel, body],
  );
}

async function deleteRow(a: At): Promise<boolean> {
  if (isTmp(a.rel)) return staged.delete(keyOf(a));
  return ((await sql(a, 'DELETE FROM records WHERE org_id = $1 AND path = $2', [a.rel])).rowCount ?? 0) > 0;
}

async function dirHasRows(a: At): Promise<boolean> {
  const [lo, hi] = under(a.rel);
  return (await sql(a, 'SELECT 1 FROM records WHERE org_id = $1 AND path >= $2 AND path < $3 LIMIT 1', [lo, hi])).rows.length > 0;
}

const asText = (data: string | Uint8Array): string => (typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));

// ── The fs.promises subset ──────────────────────────────────────────────────

export function readFile(p: string): Promise<Buffer>;
export function readFile(p: string, enc: BufferEncoding): Promise<string>;
export async function readFile(p: string, enc?: BufferEncoding): Promise<string | Buffer> {
  const a = rec(p);
  if (!a) return enc ? fs.promises.readFile(p, enc) : fs.promises.readFile(p);
  const body = await readRow(a);
  if (body === undefined) throw enoent('open', p);
  return enc === 'utf8' || enc === 'utf-8' ? body : enc ? Buffer.from(body, 'utf8').toString(enc) : Buffer.from(body, 'utf8');
}

export async function writeFile(p: string, data: string | Uint8Array, opts?: BufferEncoding | fs.WriteFileOptions): Promise<void> {
  const a = rec(p);
  if (!a) return fs.promises.writeFile(p, data, opts);
  await writeRow(a, asText(data));
}

export async function rename(from: string, to: string): Promise<void> {
  const a = rec(from);
  const b = rec(to);
  if (!a && !b) return fs.promises.rename(from, to);
  if (a && b && !isTmp(b.rel)) {
    if (isTmp(a.rel)) {
      const body = staged.get(keyOf(a));
      if (body === undefined) throw enoent('rename', from);
      await writeRow(b, body);
      staged.delete(keyOf(a));
      return;
    }
    if (a.rel === b.rel) {
      if ((await readRow(a)) === undefined) throw enoent('rename', from);
      return;
    }
    const r = await sql(
      a,
      `WITH gone AS (DELETE FROM records WHERE org_id = $1 AND path = $2 RETURNING body)
       INSERT INTO records (org_id, path, body) SELECT $1, $3, body FROM gone
       ON CONFLICT (org_id, path) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
      [a.rel, b.rel],
    );
    if (!r.rowCount) throw enoent('rename', from);
    return;
  }
  // Across the boundary (a record renamed to a non-record name, or into a tmp).
  await writeFile(to, await readFile(from));
  await rm(from);
}

export async function copyFile(from: string, to: string): Promise<void> {
  if (!rec(from) && !rec(to)) return fs.promises.copyFile(from, to);
  await writeFile(to, await readFile(from));
}

export async function access(p: string): Promise<void> {
  const a = at(p);
  if (!a) return fs.promises.access(p);
  if (isRecordPath(a.rel)) {
    if ((await readRow(a)) === undefined) throw enoent('access', p);
    return;
  }
  try {
    await fs.promises.access(p);
  } catch (err) {
    if (!(await dirHasRows(a))) throw err;
  }
}

/** `access` as a boolean — the async stand-in for `fs.existsSync` on a record path. */
export async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function unlink(p: string): Promise<void> {
  const a = rec(p);
  if (!a) return fs.promises.unlink(p);
  if (!(await deleteRow(a))) throw enoent('unlink', p);
}

export async function rm(p: string, opts?: fs.RmOptions): Promise<void> {
  const a = at(p);
  if (!a) return fs.promises.rm(p, opts);
  if (isRecordPath(a.rel)) {
    if (!(await deleteRow(a)) && !opts?.force) throw enoent('rm', p);
    return;
  }
  let diskErr: unknown = null;
  try {
    await fs.promises.rm(p, opts);
  } catch (err) {
    diskErr = err;
  }
  let rows = 0;
  if (opts?.recursive) {
    const [lo, hi] = under(a.rel);
    rows = (await sql(a, 'DELETE FROM records WHERE org_id = $1 AND path >= $2 AND path < $3', [lo, hi])).rowCount ?? 0;
  }
  if (diskErr && !(rows > 0 && (diskErr as NodeJS.ErrnoException).code === 'ENOENT')) throw diskErr;
}

function dirent(name: string, file: boolean): Dirent {
  return { name, isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false };
}

export function readdir(p: string): Promise<string[]>;
export function readdir(p: string, opts: { withFileTypes: true }): Promise<Dirent[]>;
export async function readdir(p: string, opts?: { withFileTypes: true }): Promise<string[] | Dirent[]> {
  const a = at(p);
  if (!a) return opts ? fs.promises.readdir(p, opts) : fs.promises.readdir(p);
  let disk: fs.Dirent[] | null = null;
  try {
    disk = await fs.promises.readdir(p, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // ponytail: one range scan over EVERY row below the directory — projects/ is
  // the whole org (4.4 ms at 2,000 rows locally) — and a store's list is then
  // one query per record (N+1). A stored `dir` column + index, and a batch
  // read for the listers, when an org's size makes Home or a gallery slow.
  const [lo, hi] = under(a.rel);
  const rows = (await sql(
    a,
    `SELECT split_part(substr(path, $2::int), '/', 1) AS name, bool_or(strpos(substr(path, $2::int), '/') = 0) AS file
     FROM records WHERE org_id = $1 AND path >= $3 AND path < $4 GROUP BY 1`,
    [lo.length + 1, lo, hi],
  )).rows as Array<{ name: string; file: boolean }>;
  if (!disk && !rows.length) throw enoent('scandir', p);
  const out = new Map<string, Dirent>();
  for (const d of disk || []) {
    if (!(d.isFile() && isRecordPath(lo + d.name))) out.set(d.name, d);
  }
  for (const r of rows) if (!out.has(r.name)) out.set(r.name, dirent(r.name, r.file));
  const list = [...out.values()].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return opts ? list : list.map((d) => d.name);
}
