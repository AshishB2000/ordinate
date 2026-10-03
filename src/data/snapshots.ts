// Data snapshots on disk — keep, list, prune. MAIN PROCESS ONLY.
//
// On every refresh of an eligible dataset (a schedule or a live connection —
// snapshotNames.isEligible) the Parquet being replaced is KEPT as
// `<id>.<stamp>.parquet` beside it, then the oldest are pruned to the dataset's
// retention (default 10, 0..100, 0 = off). The file names, the stamp and the
// as-of rule live in snapshotNames.ts; this file does the I/O.
//
// THE HOOK. datasets.updateDatasetData — the one write every refresh ends in —
// wraps its persist in `keepAround`: the current table is COPIED to a temp
// sibling first, the write runs, and only when it succeeded is the copy renamed
// into place. A failed refresh therefore leaves no snapshot of data that is
// still current, and a failed keep never fails the refresh (it is logged).
//
// THE INDEX. `<id>.snapshots.json` holds the retention and, per stamp, the
// columns (names + Ordinate types — the Parquet holds positional VARCHAR only)
// and the row count. A Parquet file with no index entry cannot be read by name,
// so it is not listed; it still counts for, and goes in, the next prune.
//
// SECURITY: both ids are UUID-checked before either reaches a path, and every
// stamp is parsed back strictly before it is joined into one.

import * as path from 'path';
import { randomUUID } from 'crypto';
import { isValidId } from '../app/ids';
import { datasetsDir, parquetPath, sourceParquetPath } from './datasetRecord';
import * as names from './snapshotNames';
import type { ParsedColumn } from './parse';
import * as recordFs from '../app/recordFs';

export interface SnapshotMeta {
  rowCount: number;
  columns: ParsedColumn[];
  /** The prepare source's columns, when a `.source.parquet` was kept with it. */
  sourceColumns?: ParsedColumn[];
}

export interface SnapshotInfo extends SnapshotMeta {
  stamp: string;
  /** ISO time the kept data was fetched — valid from. */
  at: string;
  parquetPath: string;
  sourcePath: string | null;
}

interface Index {
  keep: number;
  items: Record<string, SnapshotMeta>;
}

/** What a refresh hands the hook: the record as it is BEFORE the write. */
export interface Keepable {
  id: string;
  rowCount: number;
  columns: ParsedColumn[];
  source?: { columns: ParsedColumn[] };
  lastRefreshedAt?: string;
  updatedAt: string;
  origin?: { kind?: string };
  autoRefresh?: unknown;
}

// ── The index file ───────────────────────────────────────────────────────────

function sanitizeColumns(raw: unknown): ParsedColumn[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ParsedColumn[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string') return null;
    out.push({ name: c.name, type: c.type === 'number' || c.type === 'date' ? c.type : 'text' });
  }
  return out;
}

function sanitizeIndex(raw: any): Index { // ponytail: untrusted JSON off disk, whitelisted below
  const idx: Index = { keep: names.sanitizeKeep(raw && raw.keep), items: {} };
  const items = raw && typeof raw.items === 'object' && raw.items ? raw.items : {};
  for (const stamp of Object.keys(items)) {
    const m = items[stamp];
    const columns = sanitizeColumns(m && m.columns);
    if (!names.parseStamp(stamp) || !columns || typeof m.rowCount !== 'number' || !(m.rowCount >= 0)) continue;
    const meta: SnapshotMeta = { rowCount: Math.floor(m.rowCount), columns };
    const src = sanitizeColumns(m.sourceColumns);
    if (src) meta.sourceColumns = src;
    idx.items[stamp] = meta;
  }
  return idx;
}

function indexPath(projectId: string, id: string): string {
  return path.join(datasetsDir(projectId), names.indexName(id));
}

async function readIndex(projectId: string, id: string): Promise<Index> {
  try {
    return sanitizeIndex(JSON.parse(await recordFs.readFile(indexPath(projectId, id), 'utf8')));
  } catch (_) {
    return sanitizeIndex(null); // none yet, or corrupt: the default, never fatal
  }
}

async function writeIndex(projectId: string, id: string, idx: Index): Promise<void> {
  const file = indexPath(projectId, id);
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(idx, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
}

// Index writes for one dataset run one at a time: a keep landing while the
// retention is being changed must not write back the item list it read first.
const locks = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const p = prev.then(fn, fn);
  const tail = p.catch(() => { /* reported to this caller */ });
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return p;
}

async function dirNames(projectId: string): Promise<string[]> {
  try {
    return await recordFs.readdir(datasetsDir(projectId));
  } catch (_) {
    return [];
  }
}

async function exists(file: string): Promise<boolean> {
  try { await recordFs.access(file); return true; } catch (_) { return false; }
}

// ── Prune ────────────────────────────────────────────────────────────────────

/** Delete beyond `idx.keep`, drop index entries whose file is gone, write the index. Lock held. */
async function pruneLocked(projectId: string, id: string, idx: Index): Promise<string[]> {
  const dir = datasetsDir(projectId);
  const found = (await dirNames(projectId)).map((n) => names.matchName(id, n)).filter((m) => m !== null);
  const mains = found.filter((m) => !m.source).map((m) => m.stamp);
  const gone = names.planPrune(mains, idx.keep);
  const dead = new Set(gone);
  for (const s of gone) {
    await recordFs.rm(path.join(dir, names.snapshotName(id, s)), { force: true });
    await recordFs.rm(path.join(dir, names.sourceName(id, s)), { force: true });
  }
  // A source companion whose table is gone is half a snapshot: nothing reads it.
  for (const m of found) {
    if (m.source && (dead.has(m.stamp) || !mains.includes(m.stamp))) {
      await recordFs.rm(path.join(dir, names.sourceName(id, m.stamp)), { force: true });
    }
  }
  for (const s of Object.keys(idx.items)) if (dead.has(s) || !mains.includes(s)) delete idx.items[s];
  await writeIndex(projectId, id, idx);
  return gone;
}

// ── Keep (the refresh hook) ──────────────────────────────────────────────────

// A restore keeps the current data whatever the dataset's eligibility: it is
// about to replace it, and that must never lose it.
const forced = new Set<string>();

export async function withForcedKeep<T>(projectId: string, id: string, fn: () => Promise<T>): Promise<T> {
  const key = projectId + '/' + id;
  forced.add(key);
  try {
    return await fn();
  } finally {
    forced.delete(key);
  }
}

interface Pending {
  commit: () => Promise<void>;
  discard: () => Promise<void>;
}

async function begin(projectId: string, rec: Keepable): Promise<Pending | null> {
  if (!isValidId(projectId) || !rec || !isValidId(rec.id)) return null;
  const id = rec.id;
  if (!names.isEligible(rec) && !forced.has(projectId + '/' + id)) return null;
  if ((await readIndex(projectId, id)).keep === 0) return null;
  const stamp = names.stampOf(rec.lastRefreshedAt) || names.stampOf(rec.updatedAt);
  if (!stamp) return null;
  const main = parquetPath(projectId, id);
  if (!(await exists(main))) return null; // a v2 record: its table is inline, nothing to copy
  const src = sourceParquetPath(projectId, id);
  const hasSource = Boolean(rec.source);
  // A pipeline without its source file cannot be restored faithfully (its
  // derived rows would be re-fed through the steps), so it is not kept at all.
  if (hasSource && !(await exists(src))) return null;

  const dir = datasetsDir(projectId);
  const tag = '.' + randomUUID() + '.tmp'; // NOT *.parquet — a temp is never listed
  const moves: Array<[string, string]> = [[path.join(dir, names.snapshotName(id, stamp)) + tag, path.join(dir, names.snapshotName(id, stamp))]];
  if (hasSource) moves.push([path.join(dir, names.sourceName(id, stamp)) + tag, path.join(dir, names.sourceName(id, stamp))]);
  const discard = async (): Promise<void> => {
    for (const [tmp] of moves) await recordFs.rm(tmp, { force: true }).catch(() => { /* best effort */ });
  };
  try {
    await recordFs.copyFile(main, moves[0][0]);
    if (hasSource) await recordFs.copyFile(src, moves[1][0]);
  } catch (err) {
    await discard();
    throw err;
  }
  const meta: SnapshotMeta = { rowCount: rec.rowCount, columns: rec.columns.map((c) => ({ name: c.name, type: c.type })) };
  if (hasSource && rec.source) meta.sourceColumns = rec.source.columns.map((c) => ({ name: c.name, type: c.type }));

  const commit = (): Promise<void> => serial(projectId + '/' + id, async () => {
    for (const [tmp, fin] of moves) await recordFs.rename(tmp, fin);
    if (!hasSource) await recordFs.rm(path.join(dir, names.sourceName(id, stamp)), { force: true });
    const idx = await readIndex(projectId, id);
    idx.items[stamp] = meta;
    await pruneLocked(projectId, id, idx);
  });
  return { commit, discard };
}

/**
 * Run `write` (the refresh's Parquet replace) with the data it replaces kept as
 * a snapshot. Rethrows the write's own error; never throws for the snapshot.
 */
export async function keepAround(projectId: string, rec: Keepable, write: () => Promise<void>): Promise<void> {
  let pending: Pending | null = null;
  try {
    pending = await begin(projectId, rec);
  } catch (err: any) {
    console.error('[snapshots] could not copy the current table:', err?.message || err);
  }
  try {
    await write();
  } catch (err) {
    if (pending) await pending.discard();
    throw err;
  }
  if (pending) {
    await pending.commit().catch((err: any) => {
      console.error('[snapshots] could not keep a snapshot:', err?.message || err);
      return pending!.discard();
    });
  }
}

// ── Reads and settings ───────────────────────────────────────────────────────

/** Every readable snapshot of a dataset, newest first. */
export async function list(projectId: string, id: string): Promise<SnapshotInfo[]> {
  if (!isValidId(projectId) || !isValidId(id)) return [];
  const dir = datasetsDir(projectId);
  const all = await dirNames(projectId);
  const idx = await readIndex(projectId, id);
  const out: SnapshotInfo[] = [];
  for (const n of all) {
    const m = names.matchName(id, n);
    const meta = m && !m.source ? idx.items[m.stamp] : undefined;
    const at = m ? names.parseStamp(m.stamp) : null;
    if (!m || !meta || !at) continue;
    const hasSource = Boolean(meta.sourceColumns) && all.includes(names.sourceName(id, m.stamp));
    const info: SnapshotInfo = {
      stamp: m.stamp, at, rowCount: meta.rowCount, columns: meta.columns,
      parquetPath: path.join(dir, n),
      sourcePath: hasSource ? path.join(dir, names.sourceName(id, m.stamp)) : null,
    };
    if (hasSource && meta.sourceColumns) info.sourceColumns = meta.sourceColumns;
    out.push(info);
  }
  out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  return out;
}

/** One snapshot by stamp, or null — the stamp is checked before it names a file. */
export async function get(projectId: string, id: string, stamp: unknown): Promise<SnapshotInfo | null> {
  if (!names.parseStamp(stamp)) return null;
  return (await list(projectId, id)).find((s) => s.stamp === stamp) || null;
}

export async function getKeep(projectId: string, id: string): Promise<number> {
  return isValidId(projectId) && isValidId(id) ? (await readIndex(projectId, id)).keep : names.DEFAULT_KEEP;
}

/** Change the retention and prune to it at once. Returns the stamps removed. */
export async function setKeep(projectId: string, id: string, keep: unknown): Promise<{ keep: number; removed: string[] } | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  return serial(projectId + '/' + id, async () => {
    const idx = await readIndex(projectId, id);
    idx.keep = names.sanitizeKeep(keep);
    const removed = await pruneLocked(projectId, id, idx);
    return { keep: idx.keep, removed };
  });
}

/** Delete every snapshot file of a dataset, and its index. */
export async function removeAll(projectId: string, id: string): Promise<void> {
  if (!isValidId(projectId) || !isValidId(id)) return;
  const dir = datasetsDir(projectId);
  for (const n of names.snapshotFiles(id, await dirNames(projectId))) {
    await recordFs.rm(path.join(dir, n), { force: true });
  }
}
