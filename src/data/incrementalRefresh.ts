// Incremental refresh of a connection (or folder) dataset — MAIN PROCESS.
//
// Called by datasetRefresh's `connection` branch, so EVERY door — ↻, the
// scheduler, a watched folder, a pipeline, the CLI — gets it, and everything
// that runs after a refresh today (markRefresh, the snapshot updateDatasetData
// keeps, dependents, alerts, quality rules, the privacy scan) still runs after
// one. Returns null when the dataset has not opted in; the caller then does the
// ordinary full refresh, unchanged.
//
// One run is either:
//   FULL — the ordinary refresh (refreshConnectionInto), after which the mark is
//          reset to the greatest cursor in the fresh data. Taken on the first
//          run, every 7th run, on "Full refresh now", and whenever an
//          incremental run cannot be trusted (columns or types changed, the
//          cursor or key column is gone, the table is not in Parquet).
//   INCREMENTAL — fetch rows with cursor >= mark − lookback (pushed to the
//          source where its dialect allows, incrementalSql.ts; otherwise
//          filtered after the fetch), type them to the stored columns, merge in
//          DuckDB (incrementalDuck.ts) and hand the result to the ordinary
//          refresh write, which publishes the table and a new source copy
//          atomically and re-applies the Prepare steps.
//
// CRASH SAFETY. Nothing is renamed over a stored file until updateDatasetData
// persists, and the mark moves only AFTER that write returns. A run that throws
// earlier leaves the table and the record exactly as they were. A crash between
// the table write and the mark write replays the same rows next time, and both
// merge modes are idempotent on a replay (incremental.ts header).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as datasets from './datasets';
import type { Dataset, DatasetOrigin } from './datasets';
import type { RefreshResult } from './datasetRefresh';
import { datasetsDir, tablePath } from './datasetRecord';
import * as inc from './incremental';
import type { FetchHow, IncrementalLogEntry, IncrementalSettings } from './incremental';
import type { ParsedColumn } from './parse';
import * as connections from '../connectors/connections';
import { getConnector } from '../connectors';
import { WATCHABLE } from '../connectors/folderWatch';
import { pushdownSql } from '../connectors/incrementalSql';
import * as incrementalDuck from '../engine/incrementalDuck';
import * as parquetStore from '../engine/parquetStore';
import { refreshConnectionInto, runSavedText, selectionForDataset } from '../ipc/connections';

type ConnOrigin = Extract<DatasetOrigin, { kind: 'connection' }>;
type Step = { done: true; result: RefreshResult } | { done: false; reason: string };

const fail = (error: string): RefreshResult => ({ ok: false, error });

/** Refresh incrementally when the dataset opted in; null otherwise. */
export async function refreshIncremental(
  projectId: string,
  id: string,
  origin: ConnOrigin,
  warnings: string[],
): Promise<RefreshResult | null> {
  const meta = await datasets.getDatasetMeta(projectId, id);
  const s = meta && meta.incremental;
  if (!meta || !s || !s.enabled) return null;
  incrementalDuck.cleanupTemps(datasetsDir(projectId), id); // whatever a crashed run left
  const startedAt = new Date().toISOString();
  const columns = meta.sourceColumns ?? meta.columns;
  // Taken BEFORE the read, so a file written during it is read again next time.
  const stamp = await folderStamp(projectId, origin);
  let reason = fullReason(s, columns, meta.resident && (await parquetStore.isSupportedAsync()));
  if (!reason) {
    const step = await runIncremental(projectId, id, origin, Boolean(meta.sourceColumns), s, columns, startedAt, warnings, stamp);
    if (step.done) return step.result;
    reason = step.reason;
  }
  return runFull(projectId, id, origin, s, reason, startedAt, warnings, stamp);
}

/** A folder table's file stamp (see IncrementalSettings.fileStamp), or null for any other source. */
async function folderStamp(projectId: string, origin: ConnOrigin): Promise<string | null> {
  const conn = await connections.getConnection(projectId, origin.connId);
  const ext = conn ? WATCHABLE[conn.connectorId] : undefined;
  if (!conn || !ext) return null;
  const selection = selectionForDataset(origin) ?? { table: conn.table, query: conn.query };
  if (!selection.table || selection.query) return null;
  const dir = typeof conn.values.path === 'string' ? path.resolve(conn.values.path) : '';
  const file = path.join(dir, ...selection.table.split('/')) + ext;
  const st = dir && file.startsWith(dir + path.sep) ? await fs.promises.stat(file).catch(() => null) : null;
  return st ? `${st.size}:${st.mtimeMs}:${st.ctimeMs}` : null;
}

/** Why this run must be full, or null when an incremental one can be trusted. */
export function fullReason(s: IncrementalSettings, columns: ParsedColumn[], parquet: boolean): string | null {
  if (s.fullNext) return 'Full refresh requested';
  if (s.highWater === null) return 'The first run sets the high-water mark';
  if (s.runsSinceFull >= inc.FULL_EVERY - 1) return `Every ${inc.FULL_EVERY}th run is a full refresh`;
  const col = columns.find((c) => c.name === s.cursorColumn);
  if (!col || !inc.isCursorType(col.type)) return `"${s.cursorColumn}" is no longer a number or date column`;
  if (inc.cursorKey(s.highWater, col.type) === null) return 'The high-water mark could not be read';
  if (s.keyColumn && !columns.some((c) => c.name === s.keyColumn)) return `The key column "${s.keyColumn}" is gone`;
  if (!parquet) return 'The stored table is not in Parquet yet';
  return null;
}

async function runIncremental(
  projectId: string,
  id: string,
  origin: ConnOrigin,
  hasSource: boolean,
  s: IncrementalSettings,
  columns: ParsedColumn[],
  startedAt: string,
  warnings: string[],
  stamp: string | null,
): Promise<Step> {
  const done = (result: RefreshResult): Step => ({ done: true, result });
  const conn = await connections.getConnection(projectId, origin.connId);
  if (!conn) return done(fail('Connection not found'));
  const def = getConnector(conn.connectorId);
  if (!def) return done(fail('Unknown connector'));
  const selection = selectionForDataset(origin) ?? { table: conn.table, query: conn.query };
  const cIdx = columns.findIndex((c) => c.name === s.cursorColumn);
  const type = columns[cIdx].type as 'number' | 'date';
  const hwKey = inc.cursorKey(s.highWater, type) as number;
  const lower = inc.lowerBound(hwKey, s.lookback, type);
  const ext = WATCHABLE[conn.connectorId];

  // A folder table whose file is exactly as the last run saw it is not read.
  if (stamp && s.fileStamp === stamp) {
    await record(projectId, id, s, { at: startedAt, mode: 'incremental', fetched: 0, inserted: 0, updated: 0,
      highWater: s.highWater, how: 'unchanged', note: 'No file changed since the last run' }, s.highWater, false, stamp);
    return done(await loaded(projectId, id, warnings));
  }

  const pushed = pushdownSql(def.family, selection, s.cursorColumn, type, lower);
  let how: FetchHow = pushed ? (ext ? 'files' : 'server') : 'after';
  let note: string | undefined;
  let res = pushed ? await runSavedText(projectId, conn.id, { query: pushed }) : null;
  if (!res || !res.ok) {
    if (res) note = 'The source refused the cursor filter, so rows were filtered after the fetch';
    how = 'after';
    res = await runSavedText(projectId, conn.id, selection);
  }
  if (!res.ok) {
    await connections.updateConnection(projectId, conn.id, { lastStatus: 'error', lastError: res.error });
    return done(fail(res.error));
  }
  if (res.truncated) {
    if (how !== 'after') return done(fail('More than 1,000,000 rows are past the high-water mark. Run a full refresh instead.'));
    warnings.push('The source returned more than 1,000,000 rows, so rows past that limit were not seen.');
  }

  const typed = inc.toBaseRows(res.header, res.body, columns);
  if (!typed.ok) return { done: false, reason: `${typed.reason}, so this run was a full refresh` };
  const batch = inc.filterBatch(typed.rows, cIdx, type, lower);
  const keyIndex = s.keyColumn ? columns.findIndex((c) => c.name === s.keyColumn) : null;

  let inserted = 0;
  let updated = 0;
  let dataset: Dataset | null = null;
  if (batch.rows.length) {
    const merged = await incrementalDuck.mergeInDuck({
      basePath: tablePath(projectId, id, (await datasets.getDatasetMeta(projectId, id))?.storageVersion, hasSource),
      columns,
      batch: batch.rows,
      keys: batch.keys,
      keyIndex,
      stem: incrementalDuck.tempStem(datasetsDir(projectId), id, randomUUID()),
    });
    inserted = merged.inserted;
    updated = merged.updated;
    // Nothing new and nothing changed: the stored table is already the answer,
    // so it is not rewritten (and no identical snapshot is kept).
    if (inserted || updated) {
      dataset = await datasets.updateDatasetData(projectId, id, { columns, rows: merged.rows }, undefined, warnings);
      if (!dataset) return done(fail('Could not write the refreshed data.'));
    }
  }

  // ONLY NOW, after the table write returned, does the mark move.
  const top = inc.maxCursor(batch.rows, cIdx, type);
  const highWater = top && top.key > hwKey ? top.value : s.highWater;
  await record(projectId, id, s, { at: startedAt, mode: 'incremental', fetched: batch.rows.length, inserted, updated,
    highWater, how, ...(note ? { note } : {}) }, highWater, false, stamp);
  await connections.updateConnection(projectId, conn.id, {
    lastStatus: 'ok', lastError: null, lastRefreshedAt: new Date().toISOString(), linkedDatasetId: id,
  });
  return done(dataset ? { ok: true, dataset, warnings } : await loaded(projectId, id, warnings));
}

async function runFull(
  projectId: string,
  id: string,
  origin: ConnOrigin,
  s: IncrementalSettings,
  reason: string,
  startedAt: string,
  warnings: string[],
  stamp: string | null,
): Promise<RefreshResult> {
  // A failure here leaves fullNext / the run count as they were, so the next
  // run is full again — a full refresh that did not land is still owed.
  const res = await refreshConnectionInto(projectId, origin.connId, id, warnings);
  if (!res.ok) return res;
  const base = res.dataset.source ?? { columns: res.dataset.columns, rows: res.dataset.rows };
  const idx = base.columns.findIndex((c) => c.name === s.cursorColumn);
  const type = idx >= 0 ? base.columns[idx].type : 'text';
  const top = inc.isCursorType(type) ? inc.maxCursor(base.rows, idx, type) : null;
  if (!top) warnings.push(`"${s.cursorColumn}" has no readable number or date values, so the next refresh will be a full one too.`);
  const highWater = top ? top.value : null;
  await record(projectId, id, s, { at: startedAt, mode: 'full', fetched: base.rows.length, inserted: null, updated: null,
    highWater, how: 'full', note: reason }, highWater, true, stamp);
  return { ok: true, dataset: res.dataset, warnings };
}

/** Write the run's outcome: the mark, the counters and one log line. */
async function record(
  projectId: string,
  id: string,
  ran: IncrementalSettings,
  entry: IncrementalLogEntry,
  highWater: inc.Cell,
  full: boolean,
  stamp: string | null,
): Promise<void> {
  await datasets.writeIncremental(projectId, id, (cur) => {
    if (!cur) return cur;
    const next: IncrementalSettings = { ...cur, log: [entry, ...cur.log].slice(0, inc.MAX_LOG), lastRunAt: entry.at };
    if (stamp) next.fileStamp = stamp; else delete next.fileStamp;
    // Settings edited mid-run (another cursor) make this run's mark meaningless.
    if (cur.cursorColumn === ran.cursorColumn) next.highWater = highWater;
    if (full) {
      next.runsSinceFull = 0;
      next.lastFullAt = entry.at;
      delete next.fullNext;
    } else {
      next.runsSinceFull = cur.runsSinceFull + 1;
    }
    return next;
  });
}

async function loaded(projectId: string, id: string, warnings: string[]): Promise<RefreshResult> {
  const ds = await datasets.getDataset(projectId, id);
  return ds ? { ok: true, dataset: ds, warnings } : fail('Dataset not found');
}
