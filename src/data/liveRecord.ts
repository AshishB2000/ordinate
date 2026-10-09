// Writing a Live dataset's record: create one, turn an extract into one, turn
// one back into an extract (docs/live-data/00-plan.md L2.1) — MAIN PROCESS ONLY.
//
// Split from ./liveDataset.ts (the record's shape and the safety net, which
// datasets.ts imports) because these three write through datasets.ts, and
// one module may not sit on both sides of that import.
//
// What each one keeps true:
//   • a Live record is schema only — no `rows`, no Parquet, no storage
//     version — so `getDatasetMeta` reads it as not resident and every reader
//     falls through to `getDataset`, which refuses (D6);
//   • extract → Live writes the record FIRST and deletes the stored copy
//     after: a failed delete leaves orphan files (reclaimed with the dataset),
//     never a Live record pointing at nothing or an extract with no table;
//   • Live → extract goes through `datasets.persist`, the one door every
//     table write takes (the answer cache hears it, the search index is built).

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import * as datasets from './datasets';
import type { Dataset } from './datasets';
import type { ParsedColumn } from './parse';
import * as projects from '../app/projects';
import * as recordFs from '../app/recordFs';
import * as queryCache from '../engine/queryCache';
import { isValidId } from '../app/ids';
import { sanitizeOrigin } from './datasetOrigin';
import { datasetFilePath, datasetsDir, parquetPath, serialized, sourceParquetPath, writeJsonAtomic } from './datasetRecord';
import { removeAll as removeSnapshots } from './snapshots';
import { removeIndex } from '../engine/dataSearchResident';
import { isLive, liveColumnsOf, newLiveSettings } from './liveDataset';

/** Create a Live dataset from a connection selection. Null when the project or the origin is not usable. */
export async function saveLiveRecord(
  projectId: string,
  input: { name: string; columns: ParsedColumn[]; origin: unknown; maxCacheAgeSec?: number },
): Promise<Dataset | null> {
  if (!isValidId(projectId) || !(await projects.getProject(projectId))) return null;
  const origin = sanitizeOrigin(input.origin);
  if (!origin || origin.kind !== 'connection') return null;
  const now = new Date().toISOString();
  const record: Dataset = {
    id: randomUUID(),
    projectId,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled dataset',
    sourceKind: 'postgres', // the display label every connection source shares (ipc/connections importAsDataset)
    columns: liveColumnsOf(input.columns),
    rows: [],
    rowCount: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 3,
    steps: [],
    origin,
    mode: 'live',
    live: newLiveSettings(input.maxCacheAgeSec, now),
  };
  const stored: Record<string, unknown> = { ...record };
  delete stored.rows; // schema only: a `rows` key would read as an inline (v2) table
  await fs.promises.mkdir(datasetsDir(projectId), { recursive: true });
  await writeJsonAtomic(datasetFilePath(projectId, record.id), stored);
  return record;
}

/**
 * Turn an extract into a Live dataset: the record becomes schema only, then the
 * stored copy, its prepare source, its snapshots and its search index go. On S3
 * the dropped `storageVersion` leaves the objects unreferenced for the storage GC.
 * The caller has checked the origin, the steps and the confirm. False when the
 * record is missing or already Live.
 */
export async function toLiveRecord(projectId: string, id: string, columns: ParsedColumn[], maxCacheAgeSec?: number): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  const now = new Date().toISOString();
  const done = await serialized(datasetFilePath(projectId, id), (raw) => {
    if (isLive(raw)) return false;
    for (const k of ['rows', 'source', 'storageVersion', 'stepCounts', 'autoRefresh', 'incremental', 'lastRefreshedAt', 'lastRefreshStatus', 'lastRefreshError']) {
      delete raw[k];
    }
    Object.assign(raw, {
      columns: liveColumnsOf(columns), rowCount: 0, steps: [], schemaVersion: 3, updatedAt: now,
      mode: 'live', live: newLiveSettings(maxCacheAgeSec, now),
    });
    return true;
  });
  if (!done) return false;
  queryCache.invalidateDataset(id, projectId);
  await removeIndex(parquetPath(projectId, id));
  await recordFs.rm(parquetPath(projectId, id), { force: true }).catch(() => undefined);
  await recordFs.rm(sourceParquetPath(projectId, id), { force: true }).catch(() => undefined);
  await removeSnapshots(projectId, id).catch(() => undefined);
  return true;
}

/**
 * Turn a Live dataset back into an extract with the rows a normal import just
 * fetched. The record keeps its id, name, origin and catalog-facing fields;
 * `mode`/`live` go, and the table is written like any refresh's.
 */
export async function toExtractRecord(
  projectId: string,
  id: string,
  table: { columns: ParsedColumn[]; rows: (string | number | null)[][] },
): Promise<Dataset | null> {
  const meta = await datasets.getDatasetMeta(projectId, id);
  if (!meta || !isLive(meta)) return null;
  const { resident: _r, sourceColumns: _s, storageVersion: _v, mode: _m, live: _l, ...rest } = meta;
  const now = new Date().toISOString();
  const ds: Dataset = {
    ...rest,
    columns: table.columns,
    rows: table.rows,
    rowCount: table.rows.length,
    schemaVersion: 2,
    steps: [],
    updatedAt: now,
    lastRefreshedAt: now,
    lastRefreshStatus: 'ok',
    lastRefreshError: null,
  };
  await datasets.persist(projectId, ds);
  return ds;
}
