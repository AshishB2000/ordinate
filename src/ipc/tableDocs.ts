// Table docs IPC — the thin edge in front of src/app/tableDocs.ts: a dataset's role, key, grain and guide,
// and the one count that says whether its declared key is really one (D2).
//
// An extract is counted by SQL over its Parquet (engine/keyCheckResident.ts) with the JS reference
// (analysis/keyCheck.ts) behind it. A Live dataset is counted ONLY here, on "Check now": one statement
// through `liveLookup` — its budget, daily limit, timeout and typed failure. A key save never asks the warehouse.
//
// `updatedBy` and `updatedAt` are stamped in the store; a payload carries only what a person typed.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { isRowPolicyError } from '../data/rowAccess';
import type { ParsedColumn } from '../data/parse';
import { getTableDoc, readableTableDoc, setTableDoc, writeKeyCheck } from '../app/tableDocs';
import type { TableDoc, TablePatch } from '../app/tableDocs';
import { keyCheckFailed, keyNotAColumn, noKeyToCheck } from '../app/tableDocMessages';
import { logger } from '../app/logger';
import { keyCheckFromRow, keyCheckJs } from '../analysis/keyCheck';
import type { KeyCheckCounts } from '../analysis/keyCheck';
import { keyCheckResident } from '../engine/keyCheckResident';
import { compileKeyCheck } from '../engine/live/compile';
import { liveLookup } from '../engine/live/liveQuery';
import type { LiveFailureCode } from '../engine/live/liveQuery';
import * as trace from '../engine/residentTrace';

export type KeyCheckReply = { ok: true; table: TableDoc } | { ok: false; error: string; code?: LiveFailureCode };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** An extract's counts: SQL over the Parquet when it can, else the JS reference over the hydrated column. */
async function extractCounts(projectId: string, datasetId: string, index: number, type: ParsedColumn['type']): Promise<KeyCheckCounts | null> {
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
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
  return ds ? keyCheckJs(ds.rows.map((r) => r[index]), type) : null;
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
  const index = meta.columns.findIndex((c) => c.name === key);
  if (index < 0) return { ok: false, error: keyNotAColumn(key) };
  let counts: KeyCheckCounts | null;
  let checkedAt = new Date().toISOString();
  if (isLive(meta)) {
    const r = await liveLookup(projectId, datasetId, (t) => compileKeyCheck(key, t.env));
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    counts = keyCheckFromRow(r.rows[0]);
    checkedAt = r.asOf.at;
  } else {
    counts = await extractCounts(projectId, datasetId, index, meta.columns[index].type);
  }
  if (!counts) return { ok: false, error: keyCheckFailed() };
  const table = await writeKeyCheck(projectId, datasetId, key, { ...counts, checkedAt });
  return { ok: true, table: table ?? (await getTableDoc(projectId, datasetId)) };
}

/** A typed refusal passes through to the route; anything else is logged here and said as `fallback`, never as the error's own words (a path, a driver message). */
function failure(err: unknown, fallback: string): { ok: false; error: string } {
  if (isRowPolicyError(err)) throw err;
  logger.error('[tableDocs]', err instanceof Error ? err.message : 'failed');
  return { ok: false, error: fallback };
}

interface Args { projectId?: unknown; datasetId?: unknown; patch?: TablePatch }

export function register(): void {
  ipcMain.handle('catalog:getTable', async (_e, { projectId, datasetId }: Args = {}) => {
    try {
      return { ok: true, table: await readableTableDoc(str(projectId), str(datasetId)) };
    } catch (err) {
      return failure(err, 'Could not read the table notes.');
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
      const before = (await getTableDoc(p, d)).key;
      const table = await setTableDoc(p, d, patch ?? {});
      if (!table) return { ok: false, error: 'Could not save the table notes.' };
      // A new key on an extract is counted before the reply. A failed count does not undo the save: "Check now" retries it.
      if (table.key && table.key !== before && !isLive(meta)) {
        const checked = await runKeyCheck(p, d);
        return { ok: true, table: checked.ok ? checked.table : table };
      }
      return { ok: true, table };
    } catch (err) {
      return failure(err, 'Could not save the table notes.');
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
