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
//     table write takes (the answer cache hears it, the search index is built);
//   • an extract made from a Live dataset — "Copy the data instead" or "Make a
//     copy" — keeps the dataset's base filters (D13) and then its calculated
//     fields (part 8) as its Prepare steps, in its FIRST write: never a moment,
//     or after a crash a copy, wider than the dataset allows or without the
//     columns its charts read.

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
import { applyPipelineAsync } from './regexOffThread';
import type { TableData, TransformStep } from './transforms';

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

/** A fetched table as an extract's data: under Prepare steps, their output, with the table as the Prepare source. */
export type ExtractData = Pick<Dataset, 'columns' | 'rows' | 'rowCount' | 'steps' | 'source' | 'stepCounts'>;

/**
 * `table` with a Live dataset's base filters, then its calcs, as its Prepare steps —
 * or the column or calc of a step the fold would SKIP or warn about (an input not in the fetched rows):
 * that copy would not be the dataset, so the caller refuses it. No steps: the table as fetched, as today.
 */
export async function extractData(table: TableData, steps: TransformStep[]): Promise<{ ok: true; data: ExtractData } | { ok: false; column: string }> {
  if (!steps.length) return { ok: true, data: { columns: table.columns, rows: table.rows, rowCount: table.rows.length, steps: [] } };
  const out = await applyPipelineAsync(table, steps); // filter and calculated_field steps: no salt, no other dataset
  if (out.warnings.length) {
    const named = (x: TransformStep): string => ('name' in x ? String(x.name) : 'column' in x ? String(x.column) : '');
    const hit = steps.find((x) => out.warnings.some((w) => w.includes(`"${named(x)}"`))) ?? steps[0];
    return { ok: false, column: named(hit) };
  }
  return { ok: true, data: { columns: out.columns, rows: out.rows, rowCount: out.rowCount, steps, source: table, stepCounts: out.stepCounts } };
}

/** The Prepare part of an extract record: nothing when there are no steps (today's record). */
function prepared(data: ExtractData): Partial<Dataset> {
  return data.source ? { source: data.source, stepCounts: data.stepCounts } : {};
}

/**
 * Turn a Live dataset back into an extract with the rows a normal import just
 * fetched (`extractData`). The record keeps its id, name, origin and
 * catalog-facing fields; `mode`/`live` go, and the top-level `baseFilters` and
 * `calculated` with them (they are the steps now: `persist` keeps only
 * KEPT_RECORD_KEYS), and the table is written like any refresh's.
 */
export async function toExtractRecord(projectId: string, id: string, data: ExtractData): Promise<Dataset | null> {
  const meta = await datasets.getDatasetMeta(projectId, id);
  if (!meta || !isLive(meta)) return null;
  const { resident: _r, sourceColumns: _s, storageVersion: _v, mode: _m, live: _l, ...rest } = meta;
  const now = new Date().toISOString();
  const ds: Dataset = {
    ...rest,
    columns: data.columns,
    rows: data.rows,
    rowCount: data.rowCount,
    schemaVersion: 2,
    steps: data.steps,
    ...prepared(data),
    updatedAt: now,
    lastRefreshedAt: now,
    lastRefreshStatus: 'ok',
    lastRefreshError: null,
  };
  await datasets.persist(projectId, ds);
  return ds;
}

/**
 * "Make a copy" of a Live dataset with Prepare steps to carry: `datasets.saveDataset`'s new record, born
 * with the steps in one write (a save then `updateSteps` would not be).
 */
export async function saveFilteredCopy(projectId: string, input: { name: string; sourceKind: Dataset['sourceKind']; origin: unknown }, data: ExtractData): Promise<Dataset | null> {
  const origin = sanitizeOrigin(input.origin);
  if (!isValidId(projectId) || !origin || !(await projects.getProject(projectId))) return null;
  const now = new Date().toISOString();
  const ds: Dataset = {
    id: randomUUID(), projectId, name: input.name, sourceKind: input.sourceKind,
    columns: data.columns, rows: data.rows, rowCount: data.rowCount, createdAt: now, updatedAt: now, schemaVersion: 2, steps: data.steps, ...prepared(data),
    origin, lastRefreshedAt: now, lastRefreshStatus: 'ok', lastRefreshError: null,
  };
  await fs.promises.mkdir(datasetsDir(projectId), { recursive: true });
  await datasets.persist(projectId, ds);
  return ds;
}
