// Where a dataset record lives on disk, and the METADATA-ONLY writes to it —
// MAIN PROCESS ONLY.
//
// Split out of datasets.ts at the 800-line cap (.claude/rules/file-size.md). One
// job: the record FILE — its paths, its atomic write, and the writers that touch
// a few metadata keys without ever reading or rewriting the table. Everything
// that hydrates, migrates or persists a table stays in datasets.ts, which
// re-exports `markRefresh` / `setAutoRefresh` so no caller changed.
//
// SECURITY: every writer validates BOTH ids as UUIDs before either reaches a
// path, so a record path can never escape userData/projects/<projectId>/datasets.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as storage from '../engine/storage';
import * as appPaths from '../app/paths';
import { isValidId } from '../app/ids';
import { sanitizeOrigin } from './datasetOrigin';
import { sanitizeAnomalyKeys } from '../analysis/anomalyWatch';
import { sanitizeQuality } from '../analysis/qualityRules';
import type { DatasetQuality } from '../analysis/qualityRules';
import type { AutoRefresh, AutoRefreshEvery } from './datasets';
import { sanitizeIncremental } from './incremental';
import type { IncrementalSettings } from './incremental';
import { cadenceAllowed, needsIncremental, sanitizeRunMs } from './refreshCadence';
import * as recordFs from '../app/recordFs';


function getProjectsBase(): string {
  return path.join(appPaths.userData(), 'projects');
}

export function datasetsDir(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'datasets');
}

export function datasetFilePath(projectId: string, id: string): string {
  return path.join(datasetsDir(projectId), id + '.json');
}

export function parquetPath(projectId: string, id: string): string {
  return path.join(datasetsDir(projectId), id + '.parquet');
}

export function sourceParquetPath(projectId: string, id: string): string {
  return path.join(datasetsDir(projectId), id + '.source.parquet');
}

/**
 * Where to READ a dataset's table (or its prepare source) now. A record written
 * on S3 names its `storageVersion` (src/engine/storage.ts): the cached copy or
 * the s3:// URL. Otherwise — the desktop, DATA_DIR storage, or a record from
 * before S3 was turned on (moved to S3 by its next write) — the sibling file.
 */
export function tablePath(projectId: string, id: string, version: unknown, source = false): string {
  if (storage.isS3() && typeof version === 'string' && isValidId(version)) return storage.readPath(projectId, id, version, source);
  return source ? sourceParquetPath(projectId, id) : parquetPath(projectId, id);
}

/** Has the record a table to read (S3 version, or the sibling Parquet)? */
export function hasTable(projectId: string, id: string, version: unknown): boolean {
  return (storage.isS3() && typeof version === 'string' && isValidId(version)) || fs.existsSync(parquetPath(projectId, id));
}

// Atomic JSON write: temp sibling then rename (atomic on same fs), so a crash
// mid-write never leaves a half-written dataset file. Copied from projects.ts.
export async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file); // atomic on same fs
}

/**
 * Whitelist an untrusted `autoRefresh` block, or undefined.
 *
 * `hasOrigin` is a parameter rather than something read here because the answer
 * must be the SANITIZED origin, not the raw one: a record whose origin was just
 * dropped for being malformed has nothing to re-fetch either, and a schedule
 * left on it would be a scheduler retrying forever against nothing.
 *
 * `incrementalOn` likewise comes from the SANITIZED incremental block: every
 * 5 or 15 minutes is refused without it (src/data/refreshCadence.ts), so a
 * hand-edited record cannot make the scheduler full-refresh that often.
 */
export function sanitizeAutoRefresh(raw: unknown, hasOrigin: boolean, incrementalOn = false): AutoRefresh | undefined {
  if (!hasOrigin || !raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (!cadenceAllowed(o.every, incrementalOn)) return undefined;
  const out: AutoRefresh = { every: o.every };
  if (typeof o.lastAutoAt === 'string' && o.lastAutoAt) out.lastAutoAt = o.lastAutoAt;
  if (o.watch === true) out.watch = true;
  const keys = sanitizeAnomalyKeys(o.lastAnomalyKeys);
  if (keys) out.lastAnomalyKeys = keys;
  const ms = sanitizeRunMs(o.lastAutoMs);
  if (ms !== undefined) out.lastAutoMs = ms;
  return out;
}

/** Is the raw record's incremental refresh on? (Sanitized: a connection origin only.) */
function incrementalOn(raw: Record<string, unknown>): boolean {
  return sanitizeIncremental(raw.incremental, sanitizeOrigin(raw.origin)?.kind)?.enabled === true;
}

/**
 * Stamp ONLY the refresh markers, leaving the stored table completely alone.
 *
 * Deliberately does NOT go through normalize()/persist(): it reads the record's
 * raw JSON, sets three keys, and writes it back atomically. That is what makes
 * "a failed refresh never destroys data" true rather than merely intended — a
 * v2 record keeps its rows inline in this very file, and a round trip through
 * persist() on a failure path would be a table rewrite driven by a code path
 * whose whole premise is that the fetch did not work.
 *
 * Returns false when the record is missing or unreadable; a failed marker write
 * is never fatal to the refresh that triggered it.
 */
export async function markRefresh(
  projectId: string,
  id: string,
  status: 'ok' | 'error',
  error: string | null,
): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  const file = datasetFilePath(projectId, id);
  try {
    const raw = JSON.parse(await recordFs.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return false;
    raw.lastRefreshStatus = status;
    raw.lastRefreshError = error;
    // Only a SUCCESS moves the clock. A failed refresh must not make stale data
    // look newly fetched — that is the exact wrong number this feature exists
    // to prevent.
    if (status === 'ok') raw.lastRefreshedAt = new Date().toISOString();
    await writeJsonAtomic(file, raw);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Set or clear a dataset's auto-refresh schedule, and stamp its last attempt.
 *
 * METADATA ONLY, like markRefresh above: it reads and rewrites the record's
 * JSON without hydrating the table. The scheduler stamps `lastAutoAt` on every
 * tick it runs, and a blocking hydrate there would freeze every window.
 *
 * `every: null` turns it off. A schedule on a dataset with no origin is refused
 * rather than stored, matching sanitizeAutoRefresh on the way back in.
 */
export async function setAutoRefresh(
  projectId: string,
  id: string,
  patch: { every?: AutoRefreshEvery | null; lastAutoAt?: string; watch?: boolean; lastAnomalyKeys?: string[]; lastAutoMs?: number },
): Promise<AutoRefresh | null | false> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  const file = datasetFilePath(projectId, id);
  try {
    const raw = JSON.parse(await recordFs.readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return false;
    if (patch.every === null) {
      delete raw.autoRefresh;
      await writeJsonAtomic(file, raw);
      return null;
    }
    if (!sanitizeOrigin(raw.origin)) return false; // nothing to re-fetch
    const fastOk = incrementalOn(raw);
    const current = sanitizeAutoRefresh(raw.autoRefresh, true, fastOk);
    const every = patch.every ?? (current ? current.every : undefined);
    // Every 5 or 15 minutes only with incremental refresh on: refused here as
    // well as on the way back in. The RPC says why before it gets this far.
    if (!cadenceAllowed(every, fastOk)) return false;
    const next: AutoRefresh = { every };
    const lastAutoAt = patch.lastAutoAt ?? (current ? current.lastAutoAt : undefined);
    if (lastAutoAt) next.lastAutoAt = lastAutoAt;
    const watch = patch.watch ?? (current ? current.watch : undefined);
    if (watch) next.watch = true;
    const keys = sanitizeAnomalyKeys(patch.lastAnomalyKeys ?? (current ? current.lastAnomalyKeys : undefined));
    if (keys) next.lastAnomalyKeys = keys;
    // A new cadence starts unmeasured: "behind" judged a different interval.
    const ms = sanitizeRunMs(patch.lastAutoMs ?? (current && current.every === every ? current.lastAutoMs : undefined));
    if (ms !== undefined) next.lastAutoMs = ms;
    raw.autoRefresh = next;
    await writeJsonAtomic(file, raw);
    return next;
  } catch (_) {
    return false;
  }
}

/**
 * Read-modify-write the record's `incremental` block (src/data/incremental.ts)
 * — METADATA ONLY, never the table, never `updatedAt`. Serialized per record
 * on the same chain as quality writes. `mutate` gets the sanitized block;
 * undefined removes it. Resolves with what was written, or false.
 */
export function writeIncremental(
  projectId: string,
  id: string,
  mutate: (current: IncrementalSettings | undefined) => IncrementalSettings | undefined,
): Promise<IncrementalSettings | undefined | false> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(false);
  return serialized(datasetFilePath(projectId, id), (raw) => {
    const kind = sanitizeOrigin(raw.origin)?.kind;
    const next = sanitizeIncremental(mutate(sanitizeIncremental(raw.incremental, kind)), kind);
    if (next) raw.incremental = next;
    else delete raw.incremental;
    // Incremental refresh off under a 5- or 15-minute schedule: the schedule
    // drops to hourly, the shortest a full refresh may run at, in this same
    // write. Never left to the sanitizer, which would turn it off silently.
    const auto = raw.autoRefresh as Record<string, unknown> | undefined;
    if (!next?.enabled && auto && typeof auto === 'object' && needsIncremental(auto.every)) {
      raw.autoRefresh = { ...auto, every: 'hourly' };
      delete (raw.autoRefresh as Record<string, unknown>).lastAutoMs;
    }
    return next;
  });
}

// Quality writes to one record are serialized: a run finishing while a rule is
// being saved must not write back the rule list it read before the save.
// ponytail: in-process chain per record; the other metadata writers above are
// last-writer-wins as they always were.
const qualityLocks = new Map<string, Promise<unknown>>();

/**
 * Read-modify-write the record's `quality` block — METADATA ONLY, and it does
 * NOT bump `updatedAt`: a check run says nothing new about the DATA, and
 * "updated" drives the list order and Home's Recent.
 *
 * `mutate` gets the current (sanitized) block; returning undefined removes it.
 * Resolves with what was written, or false when the record is missing/unreadable.
 */
export function writeQuality(
  projectId: string,
  id: string,
  mutate: (current: DatasetQuality | undefined) => DatasetQuality | undefined,
): Promise<DatasetQuality | undefined | false> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(false);
  return serialized(datasetFilePath(projectId, id), (raw) => {
    const next = sanitizeQuality(mutate(sanitizeQuality(raw.quality)));
    if (next) raw.quality = next;
    else delete raw.quality;
    return next;
  });
}

/** Read the raw record, let `apply` edit it, write it back — one at a time per file. */
function serialized<T>(file: string, apply: (raw: Record<string, unknown>) => T): Promise<T | false> {
  const run = async (): Promise<T | false> => {
    try {
      const raw = JSON.parse(await recordFs.readFile(file, 'utf8'));
      if (!raw || typeof raw !== 'object') return false;
      const next = apply(raw);
      await writeJsonAtomic(file, raw);
      return next;
    } catch (_) {
      return false;
    }
  };
  const prev = qualityLocks.get(file) || Promise.resolve();
  const p = prev.then(run, run);
  qualityLocks.set(file, p);
  void p.then(() => { if (qualityLocks.get(file) === p) qualityLocks.delete(file); });
  return p;
}
