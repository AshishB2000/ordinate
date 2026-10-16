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
//     statistics tile over a dataset without the column; a visual whose labels
//     come from a related dataset, or whose measure is a saved formula metric
//     (both read another dataset); a KPI over a formula metric; and the
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
import { paramRefs } from '../analysis/params';
import { lodFields } from '../analysis/lodQuery';
import type { FilterStep, TransformStep } from '../data/transforms';
import type { VizEncoding } from '../analysis/visuals';
import type { CardControl } from '../analysis/dashboards';
import { vizDataFor } from '../ipc/visuals';
import { embedControlLocked } from '../server/embedMessages';

export type LockValue = string | number;

export interface Lock {
  /** column → the values it is held to (never empty: an empty `in` would widen). */
  readonly values: Readonly<Record<string, readonly LockValue[]>>;
  /** The filter steps, one per column. */
  readonly steps: readonly FilterStep[];
  /** Has every dataset id asked so far every locked column? Memoised per build. */
  covers(projectId: string, datasetId: string | undefined): Promise<boolean>;
}

/** The filter step a locked column becomes. */
export function lockStep(column: string, values: readonly LockValue[]): FilterStep {
  return values.length === 1
    ? { type: 'filter', column, op: '=', value: values[0], context: true }
    : { type: 'filter', column, op: 'in', values: values.slice(), context: true };
}

/** The lock for one build, or null when the token locks nothing. */
/**
 * Does a dataset's prepare pipeline store a value computed across rows — so
 * over every customer? A window partitioned by every locked column stays
 * inside one customer's rows and is fine.
 */
export function storesCrossRow(steps: readonly TransformStep[] | undefined, locked: readonly string[]): boolean {
  const list = Array.isArray(steps) ? steps : [];
  const crosses = (s: TransformStep): boolean => {
    const t = s.type as string;
    if (t === 'segment') return true;
    if (t !== 'window') return false;
    const by = (s as unknown as { partitionBy?: string[] }).partitionBy ?? [];
    return !locked.every((c) => by.includes(c));
  };
  return list.some((s) => !!s && crosses(s)) || lodFields(list as TransformStep[]).length > 0;
}

export function makeLock(values: Readonly<Record<string, readonly LockValue[]>>): Lock | null {
  const cols = Object.keys(values);
  if (!cols.length) return null;
  if (cols.some((c) => !values[c] || values[c].length === 0)) throw new Error('an empty lock would widen the embed');
  // A parameter reference would be bound (and an unset one would DROP the step): a lock is literal values only.
  if (cols.some((c) => values[c].some((v) => paramRefs(v).length > 0))) throw new Error('a lock value names a parameter');
  const seen = new Map<string, Promise<boolean>>();
  return {
    values,
    steps: cols.map((c) => lockStep(c, values[c])),
    covers(projectId, datasetId) {
      if (!datasetId) return Promise.resolve(false);
      const key = `${projectId}:${datasetId}`;
      let hit = seen.get(key);
      if (!hit) {
        hit = datasets.getDatasetMeta(projectId, datasetId).then(
          (meta) => !!meta && cols.every((c) => meta.columns.some((x) => x.name === c)) && !storesCrossRow((meta as { steps?: TransformStep[] }).steps, cols),
          () => false,
        );
        seen.set(key, hit);
      }
      return hit;
    },
  };
}

/** May a visual tile be drawn under `lock`? */
export async function visualAllowed(lock: Lock, projectId: string, datasetId: string, enc: VizEncoding): Promise<boolean> {
  if (hasMetricMeasure(enc)) return false; // a saved formula metric reads its own datasets
  for (const other of [enc.categoryDatasetId, enc.seriesDatasetId]) if (other && other !== datasetId) return false;
  return lock.covers(projectId, datasetId);
}

/** May a KPI tile be drawn under `lock`? A saved metric must be a plain one over a covered dataset. */
export async function metricAllowed(lock: Lock, projectId: string, m: { datasetId?: string; metricId?: string }): Promise<boolean> {
  if (m.metricId) {
    const def = await metrics.getMetric(projectId, m.metricId);
    if (def && (metrics.isFormulaDefinition(def.definition) || !(await lock.covers(projectId, def.datasetId)))) return false;
  }
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
