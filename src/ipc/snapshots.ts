// Data snapshots IPC — MAIN PROCESS.
//
//   snapshots:list           a dataset's kept snapshots, its retention, whether it is eligible
//   snapshots:setKeep        change the retention (0..100) and prune to it
//   snapshots:diff           a snapshot against the current table (DuckDB, JS fallback)
//   snapshots:restore        make a snapshot current, through the refresh path
//   snapshots:stamps         the "As of" picker's times for the datasets on a page
//   snapshots:metricHistory  a metric's value on each snapshot, and now
//
// The "As of" reads themselves ride the ordinary channels (visual:data,
// metric:value, dashboard:metric, visual:rows) with an `asOf` field — see
// src/data/asOf.ts. Every figure here is computed by the app; nothing is stored.

import { ipcMain } from 'electron';
import * as datasets from '../data/datasets';
import * as snapshots from '../data/snapshots';
import { isEligible } from '../data/snapshotNames';
import { restoreSnapshot } from '../data/snapshotRestore';
import { diffParquet } from '../engine/snapshotDiff';
import { diffTablesJs } from '../data/snapshotDiffJs';
import type { DiffResult } from '../data/snapshotDiffJs';
import * as parquetStore from '../engine/parquetStore';
import * as trace from '../engine/residentTrace';
import { runAsOf } from '../data/asOf';
import * as metrics from '../analysis/metrics';
import { resolveMetric } from './metrics';
import { afterRefresh } from './datasets';
import { isValidId } from '../app/ids';
import type { BuildDeps } from './build';

/** How many datasets / metrics one picker may ask about — a page, not a project dump. */
const MAX_PICKER_IDS = 50;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** The diff, off the two files in place; the JS reference over the same bytes if DuckDB fails. */
export async function diffSnapshot(
  projectId: string, datasetId: string, stamp: unknown, key: unknown, limit: unknown,
): Promise<{ ok: true; diff: DiffResult; at: string } | { ok: false; error: string }> {
  const snap = await snapshots.get(projectId, datasetId, stamp);
  if (!snap) return fail('That snapshot is no longer kept.');
  const cur = await datasets.residentSource(projectId, datasetId);
  if (!cur) return fail('The current table cannot be read for a comparison.');
  const old = { parquetPath: snap.parquetPath, columns: snap.columns };
  let d = await diffParquet(old, cur, key, limit);
  if (d === null) {
    trace.record('snapshotDiff', 'failed');
    // No schema: the cells come back exactly as stored, which is what the diff compares.
    const [o, n] = await Promise.all([parquetStore.readTableAsync(old.parquetPath), parquetStore.readTableAsync(cur.parquetPath)]);
    if (!o || !n) return fail('The two versions could not be read.');
    d = diffTablesJs({ columns: old.columns, rows: o.rows }, { columns: cur.columns, rows: n.rows }, key, limit);
  } else if (!('error' in d)) {
    trace.record('snapshotDiff', 'resident');
  }
  return 'error' in d ? fail(d.error) : { ok: true, diff: d, at: snap.at };
}

export interface MetricPoint {
  at: string;
  value: number | null;
  display: string;
  latest: boolean;
}

/** A metric's value on each kept snapshot of its dataset (oldest first), then now. */
export async function metricHistory(projectId: string, metricId: string): Promise<MetricPoint[] | null> {
  const m = await metrics.getMetric(projectId, metricId);
  if (!m) return null;
  const meta = await datasets.getDatasetMeta(projectId, m.datasetId);
  if (!meta) return null;
  const points: MetricPoint[] = [];
  for (const s of (await snapshots.list(projectId, m.datasetId)).reverse()) {
    const r = await runAsOf(projectId, Date.parse(s.at), () => resolveMetric(projectId, metricId));
    const v = r.missing || !r.value ? null : r.value.value;
    points.push({ at: s.at, value: v, display: r.missing || !r.value ? '—' : r.value.display, latest: false });
  }
  const now = await resolveMetric(projectId, metricId);
  points.push({ at: meta.lastRefreshedAt || meta.updatedAt, value: now ? now.value : null, display: now ? now.display : '—', latest: true });
  return points;
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x) => isValidId(x)))].slice(0, MAX_PICKER_IDS) as string[] : [];
}

export function register(deps: BuildDeps): void {
  void deps; // no timers or watchers here — a headless run registers the same reads

  ipcMain.handle('snapshots:list', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      const meta = await datasets.getDatasetMeta(projectId, datasetId);
      if (!meta) return fail('Dataset not found');
      const items = await snapshots.list(projectId, datasetId);
      return {
        ok: true,
        eligible: isEligible(meta),
        refreshable: Boolean(meta.origin && meta.origin.kind !== 'capture'),
        keep: await snapshots.getKeep(projectId, datasetId),
        current: { at: meta.lastRefreshedAt || meta.updatedAt, rowCount: meta.rowCount, columns: meta.columns.map((c) => c.name) },
        items: items.map((s) => ({
          stamp: s.stamp, at: s.at, rowCount: s.rowCount, columns: s.columns.map((c) => c.name), hasSource: Boolean(s.sourcePath),
        })),
      };
    } catch (err: any) {
      return fail(err?.message || 'Could not list the snapshots');
    }
  });

  ipcMain.handle('snapshots:setKeep', async (_e, { projectId, datasetId, keep }: any = {}) => {
    try {
      if (!(await datasets.getDatasetMeta(projectId, datasetId))) return fail('Dataset not found');
      const r = await snapshots.setKeep(projectId, datasetId, keep);
      return r ? { ok: true, keep: r.keep, removed: r.removed.length } : fail('Dataset not found');
    } catch (err: any) {
      return fail(err?.message || 'Could not change how many snapshots are kept');
    }
  });

  ipcMain.handle('snapshots:diff', async (_e, { projectId, datasetId, stamp, key, limit }: any = {}) => {
    try {
      return await diffSnapshot(projectId, datasetId, stamp, key, limit);
    } catch (err: any) {
      return fail(err?.message || 'Could not compare the snapshot');
    }
  });

  ipcMain.handle('snapshots:restore', async (_e, { projectId, datasetId, stamp }: any = {}) => {
    try {
      const r = await restoreSnapshot(projectId, datasetId, stamp);
      if (!r.ok) return r;
      await afterRefresh(projectId, datasetId);
      // The record without its tables — no caller reads the rows.
      const { rows: _rows, source: _source, ...dataset } = r.dataset;
      return { ok: true, dataset };
    } catch (err: any) {
      return fail(err?.message || 'Could not restore the snapshot');
    }
  });

  ipcMain.handle('snapshots:stamps', async (_e, { projectId, datasetIds, metricIds }: any = {}) => {
    try {
      const want = new Set(ids(datasetIds));
      for (const mid of ids(metricIds)) {
        const m = await metrics.getMetric(projectId, mid);
        if (m) want.add(m.datasetId);
      }
      const byAt = new Map<string, { at: string; datasets: string[] }>();
      for (const id of want) {
        const meta = await datasets.getDatasetMeta(projectId, id);
        if (!meta) continue;
        for (const s of await snapshots.list(projectId, id)) {
          const e = byAt.get(s.at) || { at: s.at, datasets: [] };
          e.datasets.push(meta.name);
          byAt.set(s.at, e);
        }
      }
      const items = [...byAt.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return { ok: true, items };
    } catch (err: any) {
      return fail(err?.message || 'Could not list the snapshot times');
    }
  });

  ipcMain.handle('snapshots:metricHistory', async (_e, { projectId, metricId }: any = {}) => {
    try {
      const points = await metricHistory(projectId, metricId);
      return points ? { ok: true, points } : fail('Metric not found');
    } catch (err: any) {
      return fail(err?.message || 'Could not compute the metric across snapshots');
    }
  });
}
