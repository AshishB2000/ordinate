// Table docs IPC — the thin edge in front of src/app/tableDocs.ts: a dataset's role, key, grain and guide,
// and the one count that says whether its declared key is really one (D2).
//
// An extract is counted by SQL over its Parquet (engine/keyCheckResident.ts) with the JS reference
// (analysis/keyCheck.ts) behind it. A Live dataset is counted ONLY here, on "Check now": one statement
// through `liveLookup` — its budget, daily limit, timeout and typed failure. A key save never asks the warehouse.
//
// When a dataset's rows change (`afterTableData`, riding the quality hook) the key is counted again and every
// relationship into the dataset is re-verified, its stored warning with it.
//
// `updatedBy` and `updatedAt` are stamped in the store; a payload carries only what a person typed.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { isLive, isLiveDatasetError } from '../data/liveDataset';
import { isRowPolicyError } from '../data/rowAccess';
import { getTableDoc, readableTableDoc, setTableDoc, writeKeyCheck } from '../app/tableDocs';
import type { TableDoc, TablePatch } from '../app/tableDocs';
import { keyCheckFailed, keyNotAColumn, noKeyToCheck, tableNotesNotRead, tableNotesNotSaved } from '../app/tableDocMessages';
import { logger } from '../app/logger';
import { listRelationships, relWarning, updateRelationships } from '../analysis/relationships';
import type { RelWarning, Relationship } from '../analysis/relationships';
import { infoFor, keyStats } from './relationships';
import { keyCheckFromRow, keyCheckJs } from '../analysis/keyCheck';
import type { KeyCheckCounts } from '../analysis/keyCheck';
import { keyCheckResident } from '../engine/keyCheckResident';
import { compileKeyCheck } from '../engine/live/compile';
import { liveLookup } from '../engine/live/liveQuery';
import type { LiveFailureCode } from '../engine/live/liveQuery';
import * as trace from '../engine/residentTrace';

export type KeyCheckReply = { ok: true; table: TableDoc } | { ok: false; error: string; code?: LiveFailureCode };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * An extract's counts: SQL over the Parquet when it can, else the JS reference over the hydrated column. The key's
 * column is found BY NAME in the columns each source returns: a refresh between two reads can reorder or drop them,
 * so an index taken from an earlier read is never reused. Null: not counted (the column is gone from that source).
 */
async function extractCounts(projectId: string, datasetId: string, key: string): Promise<KeyCheckCounts | null> {
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    const index = src.columns.findIndex((c) => c.name === key);
    if (index < 0) return null;
    const type = src.columns[index].type;
    const fast = await keyCheckResident({ parquetPath: src.parquetPath, index, type });
    if (fast) {
      trace.record('keyCheck', 'resident');
      return fast;
    }
    trace.record('keyCheck', 'failed', `${type} key`);
  } else {
    trace.record('keyCheck', 'skipped');
  }
  const ds = await datasets.getDataset(projectId, datasetId);
  const index = ds ? ds.columns.findIndex((c) => c.name === key) : -1;
  return ds && index >= 0 ? keyCheckJs(ds.rows.map((r) => r[index]), ds.columns[index].type) : null;
}

/**
 * Count the dataset's declared key and store the result under that key. A key changed while the count ran
 * is not stamped (`writeKeyCheck`): the reply then carries the doc as it stands. `checkedAt` is when the
 * warehouse answered, for a Live dataset.
 */
export async function runKeyCheck(projectId: string, datasetId: string): Promise<KeyCheckReply> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  const { key } = await getTableDoc(projectId, datasetId);
  if (!key) return { ok: false, error: noKeyToCheck() };
  if (!meta.columns.some((c) => c.name === key)) return { ok: false, error: keyNotAColumn(key) };
  let counts: KeyCheckCounts | null;
  let checkedAt = new Date().toISOString();
  if (isLive(meta)) {
    const r = await liveLookup(projectId, datasetId, (t) => compileKeyCheck(key, t.env));
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    counts = keyCheckFromRow(r.rows[0]);
    checkedAt = r.asOf.at;
  } else {
    counts = await extractCounts(projectId, datasetId, key);
  }
  if (!counts) return { ok: false, error: keyCheckFailed() };
  const table = await writeKeyCheck(projectId, datasetId, key, { ...counts, checkedAt });
  return { ok: true, table: table ?? (await getTableDoc(projectId, datasetId)) };
}

/** A refusal the route types (a Live dataset, a row lock) passes through; everything else is the handler's to say. */
const typed = (err: unknown): boolean => isLiveDatasetError(err) || isRowPolicyError(err);

/** A typed refusal passes through to the route; anything else is logged here and said as `fallback`, never as the error's own words (a path, a driver message). */
function failure(err: unknown, fallback: string): { ok: false; error: string } {
  if (typed(err)) throw err;
  logger.error('[tableDocs]', err instanceof Error ? err.message : 'failed');
  return { ok: false, error: fallback };
}

/** A new key's count, stored before the reply. A count that throws does not undo the save that already happened: the saved doc stands and "Check now" retries. */
async function countedAfterSave(projectId: string, datasetId: string, saved: TableDoc): Promise<TableDoc> {
  try {
    const checked = await runKeyCheck(projectId, datasetId);
    return checked.ok ? checked.table : saved;
  } catch (err) {
    if (typed(err)) throw err;
    logger.error('[tableDocs] the key could not be counted after the save:', err instanceof Error ? err.message : 'failed');
    return saved;
  }
}

// ── The rows changed ─────────────────────────────────────────────────────────

/**
 * Recompute `verified` and `warning` of every relationship whose TO side is this dataset, from full-table counts over
 * the rows it has now and the key it declares now. The counts run outside the lock; the write goes through
 * `updateRelationships` and touches only those two fields of an entry that still joins the same two columns, so a
 * person's save made meanwhile is never lost. Nothing is written when the counts did not move, or when the declared key
 * moved since they were made (the re-check that follows that key owns the warnings). Never throws: a relationship that
 * cannot be counted (a Live side, a column gone) stays as it was.
 */
export async function recheckRelationshipsTo(projectId: string, datasetId: string): Promise<void> {
  try {
    const into = (await listRelationships(projectId)).filter((r) => r.to.datasetId === datasetId);
    if (!into.length) return;
    const { key } = await getTableDoc(projectId, datasetId);
    const fresh = new Map<string, { counted: Relationship; verified: Relationship['verified']; warning: RelWarning | undefined }>();
    for (const r of into) {
      try {
        const fromMeta = await datasets.getDatasetMeta(projectId, r.from.datasetId);
        if (!fromMeta || isLive(fromMeta)) continue; // a Live side has no rows here: its relationships are not re-verified
        const from = { id: r.from.datasetId, name: fromMeta.name, columns: fromMeta.columns };
        const to = await infoFor(projectId, r.to.datasetId);
        if (!to || !from.columns.some((c) => c.name === r.from.column) || !to.columns.some((c) => c.name === r.to.column)) continue;
        const stats = await keyStats(projectId, from, r.from.column, to, r.to.column);
        if (stats) fresh.set(r.id, { counted: r, verified: { matched: stats.matched, unmatchedFrom: stats.unmatchedFrom }, warning: relWarning(stats, key, r.to.column) });
      } catch (err) {
        logger.error('[tableDocs] a relationship could not be re-verified:', err instanceof Error ? err.message : 'failed');
      }
    }
    if (!fresh.size) return;
    await updateRelationships(projectId, async (list) => {
      // The key moved while this counted: the warnings were judged against the old one, and the re-check that follows the new key owns them.
      if ((await getTableDoc(projectId, datasetId)).key !== key) return list;
      let changed = false;
      const next = list.map((r) => {
        const f = fresh.get(r.id);
        const same = f && r.from.datasetId === f.counted.from.datasetId && r.from.column === f.counted.from.column && r.to.datasetId === f.counted.to.datasetId && r.to.column === f.counted.to.column;
        if (!f || !same || (r.verified.matched === f.verified.matched && r.verified.unmatchedFrom === f.verified.unmatchedFrom && JSON.stringify(r.warning) === JSON.stringify(f.warning))) return r;
        changed = true;
        const { warning: _old, ...rest } = r;
        return { ...rest, verified: f.verified, ...(f.warning && { warning: f.warning }) };
      });
      return changed ? next : list;
    });
  } catch (err) {
    logger.error('[tableDocs] relationships were not re-verified:', err instanceof Error ? err.message : 'failed');
  }
}

/**
 * The hook for "this dataset's rows changed" — `runQualityChecks` calls it, which every save, refresh, recapture and
 * pipeline change already reaches. Counts the declared key again (or clears the count when its column is gone) and
 * re-verifies the relationships into the dataset. A Live dataset has no rows here: its key is counted on "Check now"
 * only (D2). With no key and no relationship into it, it returns before reading a row. Never throws.
 */
export async function afterTableData(projectId: string, datasetId: string): Promise<void> {
  try {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta || isLive(meta)) return;
    const { key } = await getTableDoc(projectId, datasetId);
    const into = (await listRelationships(projectId)).some((r) => r.to.datasetId === datasetId);
    if (key) {
      try {
        if (meta.columns.some((c) => c.name === key)) await runKeyCheck(projectId, datasetId);
        else await writeKeyCheck(projectId, datasetId, key, null); // the column is gone: its old count would be a stale "✓ unique"
      } catch (err) {
        logger.error('[tableDocs] the key was not re-counted after its rows changed:', err instanceof Error ? err.message : 'failed'); // the relationships below do not depend on it
      }
    }
    if (into) await recheckRelationshipsTo(projectId, datasetId);
  } catch (err) {
    logger.error('[tableDocs] the table was not re-checked after its rows changed:', err instanceof Error ? err.message : 'failed');
  }
}

// ── Channels ─────────────────────────────────────────────────────────────────

interface Args { projectId?: unknown; datasetId?: unknown; patch?: TablePatch }

export function register(): void {
  ipcMain.handle('catalog:getTable', async (_e, { projectId, datasetId }: Args = {}) => {
    try {
      return { ok: true, table: await readableTableDoc(str(projectId), str(datasetId)) };
    } catch (err) {
      return failure(err, tableNotesNotRead());
    }
  });

  ipcMain.handle('catalog:setTable', async (_e, { projectId, datasetId, patch }: Args = {}) => {
    try {
      const p = str(projectId);
      const d = str(datasetId);
      // A key is checked against the dataset's CURRENT columns — the record's, never its rows.
      const meta = await datasets.getDatasetMeta(p, d);
      if (!meta) return { ok: false, error: 'Dataset not found' };
      const asked = str(patch?.key);
      if (asked && !meta.columns.some((c) => c.name === asked)) return { ok: false, error: keyNotAColumn(asked) };
      const saved = await setTableDoc(p, d, patch ?? {});
      if (!saved) return { ok: false, error: tableNotesNotSaved() };
      let table = saved.table;
      // A new key on an extract is counted before the reply, and the relationships into the dataset are re-judged against it.
      if (saved.keyChanged && !isLive(meta)) {
        if (table.key) table = await countedAfterSave(p, d, table);
        await recheckRelationshipsTo(p, d);
      }
      return { ok: true, table };
    } catch (err) {
      return failure(err, tableNotesNotSaved());
    }
  });

  ipcMain.handle('catalog:checkKey', async (_e, { projectId, datasetId }: Args = {}) => {
    try {
      return await runKeyCheck(str(projectId), str(datasetId));
    } catch (err) {
      return failure(err, keyCheckFailed());
    }
  });
}
