// Locked filters for an embedded dashboard (docs/embed/00-design.md) — MAIN.
//
// A signed embed token may hold columns to values ("Customer = Acme"). They
// are the row scoping that makes customer-facing embedding possible, so they
// are enforced HERE, in the data path, never in the page:
//
//   - each locked column is ONE filter step (`=` for a value, `in` for
//     several) with `context: true`, so it applies before LOD expressions
//     too, placed FIRST in every tile's filter list (dashboardData.ts);
//   - a tile that cannot honour every lock is REFUSED, never drawn: the
//     pipeline SKIPS a filter on a column its dataset lacks (transforms.ts
//     stepFilter), which would draw the unscoped figure. So: a visual, KPI or
//     statistics tile over a dataset without the column; a visual or KPI that
//     reads a related dataset — labels, a series, a measure or a filter column
//     a relationship supplies (that dataset's stored values, which may have
//     been computed across every customer), or a saved formula metric; and the
//     Summary card (its facts — insights, quality, alerts — are about the
//     whole dataset); and a tile over a dataset whose prepare steps STORE a
//     value computed across rows — a LOD field, a window (running total, rank,
//     share of total), a segment — since that value was computed over every
//     customer's rows before any filter (only the main chart path recomputes a
//     LOD under context filters; statistics, currency and parameter replay read
//     the stored value);
//   - the filter bar's options are data too: a control on a locked column
//     offers the locked values; a text dropdown on another column offers only
//     the values that exist under the lock; anything else is left out.
//
// Nothing here computes a figure: the options come through `vizDataFor`, the
// same door every chart takes.

import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import { isLive } from '../data/liveDataset';
import { hasMetricMeasure } from '../analysis/metricMeasures';
import { OTHER_LABEL } from '../analysis/categoryKey';
import type { VizEncoding } from '../analysis/visuals';
import type { CardControl } from '../analysis/dashboards';
import { vizDataFor } from '../ipc/visuals';
import { embedControlLocked } from '../server/embedMessages';
import type { Lock } from '../data/rowLock';
import type { FilterStep } from '../data/transforms';
import { chartReads, metricReads } from '../ipc/relationships';

// The lock itself (steps, cross-row rule, coverage) is shared with row access rules: ../data/rowLock.ts.
export { lockStep, makeLock, storesCrossRow } from '../data/rowLock';
export type { Lock, LockValue } from '../data/rowLock';

/** Does a KPI's column or a filter resolve to a related dataset? It is read there, past the lock (NV-19). */
async function metricReadsOther(projectId: string, datasetId: string | undefined, column: string | undefined, filters: FilterStep[]): Promise<boolean> {
  return !!datasetId && (await metricReads(projectId, datasetId, column ?? '', filters)).length > 0;
}

/** May a visual tile be drawn under `lock`? `filters`: every filter it is drawn with. Only its own dataset is read. */
export async function visualAllowed(lock: Lock, projectId: string, datasetId: string, enc: VizEncoding, filters: FilterStep[] = []): Promise<boolean> {
  if (hasMetricMeasure(enc)) return false; // a saved formula metric reads its own datasets
  const named = [enc.categoryDatasetId, enc.seriesDatasetId, ...(Array.isArray(enc.values) ? enc.values.map((v) => v && v.datasetId) : [])];
  for (const other of named) if (other && other !== datasetId) return false;
  if ((await chartReads(projectId, datasetId, enc, filters)).length) return false;
  return lock.covers(projectId, datasetId);
}

/** May a KPI tile be drawn under `lock`? A saved metric must be a plain one over a covered dataset; nothing related is read. */
export async function metricAllowed(lock: Lock, projectId: string, m: { datasetId?: string; metricId?: string; column?: string }, filters: FilterStep[] = []): Promise<boolean> {
  if (m.metricId) {
    const def = await metrics.getMetric(projectId, m.metricId);
    if (def && (metrics.isFormulaDefinition(def.definition) || !(await lock.covers(projectId, def.datasetId))
      || (await metricReadsOther(projectId, def.datasetId, def.definition.column, filters)))) return false;
  }
  if (await metricReadsOther(projectId, m.datasetId, m.column, filters)) return false;
  return lock.covers(projectId, m.datasetId);
}

/**
 * A dropdown / multi control's options under `lock`: the locked values on a
 * locked column; else the text values that exist under the lock, most rows
 * first. A string is the reason it is left out of the filter bar.
 */
export async function lockedOptions(lock: Lock, projectId: string, control: CardControl, max: number): Promise<string[] | string> {
  const locked = Object.prototype.hasOwnProperty.call(lock.values, control.column) ? lock.values[control.column] : undefined;
  if (locked) return [...new Set(locked.map(String))].slice(0, max);
  if (!(await lock.covers(projectId, control.datasetId))) return embedControlLocked();
  const meta = await datasets.getDatasetMeta(projectId, control.datasetId);
  const col = meta?.columns.find((c) => c.name === control.column);
  // A Live dataset's option list is a SAMPLE of the whole table; a number or date column is bucketed by the chart door.
  if (!meta || isLive(meta) || !col || col.type !== 'text') return embedControlLocked();
  const enc: VizEncoding = { category: control.column, values: [{ column: control.column, aggregation: 'count' }] };
  const r = await vizDataFor(projectId, control.datasetId, enc, [...lock.steps]);
  if (!r.ok) return embedControlLocked();
  const counts = r.data.series[0]?.values ?? [];
  const folded = !!r.category && 'note' in r.category && !!r.category.note; // the tail went into 'Other', which is no value
  return r.data.labels
    .map((l, i) => ({ l: l == null ? '' : String(l), n: typeof counts[i] === 'number' ? (counts[i] as number) : 0, i }))
    .filter((x) => x.l !== '' && !(folded && x.l === OTHER_LABEL))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, max)
    .map((x) => x.l);
}
