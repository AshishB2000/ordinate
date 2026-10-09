// The browser's views of a dataset (T2.3) — server only, registered by
// src/server/app.ts. Two channels the desktop renderer never needed, because
// it read `dataset:meta` whole and did the panel's arithmetic itself:
//
//   dataset:source   where the rows came from, REDACTED to a kind and a label
//                    (src/data/datasetOrigin.ts `sourceView`) — `dataset:meta`
//                    carries the origin, which can hold a URL with a key in it,
//                    a server path or a statement, and is not contracted.
//   dataset:profile  one column's profile panel with every figure on it
//                    computed here (src/data/profileView.ts): the summary
//                    `dataset:stats` computes, the median `dataset:median`
//                    does, the distinct total `dataset:distinct` does and the
//                    `visual:data` count series (20 bins / month grain), so the
//                    panel and a chart of the column cannot bucket differently.
//
// Each figure is read the way the desktop's own channel reads it: off the
// stored Parquet when the resident path answers, else the JS reference over
// the hydrated table — the same two-path rule, the same functions.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { computeColumnSummary, type ColumnSummary } from '../data/datasetStats';
import { sourceView } from '../data/datasetOrigin';
import { columnProfile, PROFILE_BINS } from '../data/profileView';
import { medianOf } from '../data/columnProfile';
import { computeColumnSummariesResident } from '../engine/statsResident';
import { medianResident } from '../engine/medianResident';
import { distinctValuesPageJs, readDistinctPage } from '../engine/datasetPage';
import { sanitizeEncoding } from '../analysis/visuals';
import * as trace from '../engine/residentTrace';
import { listConnections } from '../connectors/connections';
import { vizDataFor } from './visuals';
import { getConnector, isLiveOffered } from '../connectors';
import { isLive } from '../data/liveDataset';
import { liveColumnProfile } from './liveProfile';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

interface Figures {
  summary: ColumnSummary | undefined;
  median: number | null;
  distinct: number | null;
}

/** The column's summary, median (numbers) and distinct total (numbers — a summary has none), resident first. */
async function figuresFor(projectId: string, datasetId: string, column: string, type: string): Promise<Figures | null> {
  const num = type === 'number';
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    const i = src.columns.findIndex((c) => c.name === column);
    const sums = await computeColumnSummariesResident(src);
    const med = num ? await medianResident(src, column) : { value: null };
    const dis = num ? await readDistinctPage(src, column, { limit: 1 }) : null;
    if (sums && med && (!num || dis)) {
      trace.record('datasetProfile', 'resident');
      return { summary: sums[i], median: med.value, distinct: dis ? dis.total : null };
    }
    trace.record('datasetProfile', 'failed', column);
  } else {
    trace.record('datasetProfile', 'skipped');
  }
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return null;
  const c = ds.columns.findIndex((x) => x.name === column);
  if (c < 0) return null;
  return {
    summary: computeColumnSummary(ds.columns[c], ds.rows.map((row) => (row ? row[c] ?? null : null))),
    median: num ? medianOf(ds.columns, ds.rows, column) : null,
    distinct: num ? distinctValuesPageJs(ds.columns, ds.rows, column, { limit: 1 }).total : null,
  };
}

/**
 * `dataset:source`'s Live half: `live` + `maxCacheAgeSec` on a Live dataset;
 * `canGoLive: true` on an extract whose CONNECTION offers Live — its connector
 * has a dialect and, for an OLTP source, the connection is ticked as a read
 * replica (L3.2). Absent otherwise, so every other dataset's reply is the
 * `{kind, label, refreshable}` it always was.
 */
function liveView(meta: datasets.DatasetMeta, connOf: (connId: string) => { connectorId: string; values: Record<string, unknown> } | undefined): { live?: true; maxCacheAgeSec?: number; canGoLive?: true } {
  if (isLive(meta) && meta.live) return { live: true, maxCacheAgeSec: meta.live.maxCacheAgeSec };
  if (meta.origin?.kind !== 'connection') return {};
  const conn = connOf(meta.origin.connId);
  return conn && isLiveOffered(getConnector(conn.connectorId), conn.values) ? { canGoLive: true } : {};
}

export function register(): void {
  ipcMain.handle('dataset:source', async (_e, { projectId, id }: Record<string, unknown> = {}) => {
    const meta = await datasets.getDatasetMeta(str(projectId), str(id));
    if (!meta) return null;
    const conns = meta.origin?.kind === 'connection' ? await listConnections(str(projectId)).catch(() => []) : [];
    const view = sourceView(meta.sourceKind, meta.origin, (cid) => conns.find((c) => c.id === cid)?.name);
    // Live (L2.1): the mode and the cache age, and whether this one COULD be
    // Live — flags and a number, never the selection's SQL or the address.
    return { ...view, ...liveView(meta, (cid) => conns.find((c) => c.id === cid)) };
  });

  ipcMain.handle('dataset:profile', async (_e, { projectId, datasetId, column }: Record<string, unknown> = {}) => {
    try {
      const p = str(projectId);
      const d = str(datasetId);
      const name = str(column);
      const meta = await datasets.getDatasetMeta(p, d);
      const col = meta?.columns.find((c) => c.name === name);
      if (!meta || !col) return { ok: false, error: 'That column is not in this dataset.' };
      // A profiled Live dataset: the panel from its sample (L2.5). Unprofiled, the paths below refuse it.
      const live = liveColumnProfile(meta, name);
      if (live) return live;
      // The distribution through `visual:data`'s own path: count of the column
      // itself, a number column in PROFILE_BINS buckets, a date by month.
      const encoding = sanitizeEncoding({
        category: name,
        values: [{ column: name, aggregation: 'count' }],
        ...(col.type === 'number' ? { bins: PROFILE_BINS } : col.type === 'date' ? { grain: 'month' } : {}),
      });
      const [figures, viz] = await Promise.all([figuresFor(p, d, name, col.type), vizDataFor(p, d, encoding, [])]);
      if (!figures) return { ok: false, error: 'Dataset not found' };
      const series = viz.ok ? viz.data.series[0] : undefined;
      const counts = viz.ok && series ? { labels: viz.data.labels, values: series.values } : null;
      return { ok: true, profile: columnProfile({ name, type: col.type }, meta.rowCount, figures.summary, figures, counts) };
    } catch (err: unknown) {
      return { ok: false, error: (err as Error)?.message || 'Could not profile the column' };
    }
  });
}
