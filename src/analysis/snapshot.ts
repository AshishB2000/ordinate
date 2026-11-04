// A snapshot metric (semantic layer part 1): a stock count is the last (or first) day's value, not a sum over
// every day. This file is the TYPE, its whitelist and the save check; metrics.ts imports from here, never the other
// way round (types only come back).

import * as datasets from '../data/datasets';
import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { dateBucket, dateBucketLabel, daysFromCivil, parseDateCell } from './categoryKey';
import type { DateGrain } from './categoryKey';
import * as msg from './metricCheckMessages';

/** Which row of each group a snapshot metric reads: the latest or the earliest by `column` (a date column). */
export interface MetricSnapshot {
  column: string;
  take: 'last' | 'first';
}

const MAX_COLUMN = 512;

/** The snapshot when `raw` is well formed, else undefined (the caller then leaves the key out). */
export function sanitizeSnapshot(raw: unknown): MetricSnapshot | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.column !== 'string' || !o.column || o.column.length > MAX_COLUMN) return undefined;
  if (o.take !== 'last' && o.take !== 'first') return undefined;
  return { column: o.column, take: o.take };
}

/**
 * The snapshot an UPDATED simple definition carries. An editor that knows no snapshots sends `{column, aggregation}`
 * with the key left out, and that must not erase the one the record has; only an explicit `null` clears it. A valid
 * incoming one replaces the stored one. `stored` is the stored definition's `snapshot` value.
 */
export function mergeSnapshot(incoming: unknown, stored: unknown): MetricSnapshot | undefined {
  return incoming === null ? undefined : (sanitizeSnapshot(incoming) ?? sanitizeSnapshot(stored));
}

/** The sentence refusing a definition whose snapshot names no date column of `datasetId`, or null (none, a date, or no dataset). */
export async function snapshotProblem(projectId: string, datasetId: string, def: unknown): Promise<string | null> {
  const snap = sanitizeSnapshot(def && typeof def === 'object' ? (def as { snapshot?: unknown }).snapshot : undefined);
  if (!snap) return null;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  return !meta || meta.columns.some((c) => c.name === snap.column && c.type === 'date') ? null : msg.snapshotNotDate(snap.column);
}

// ── Which rows a snapshot keeps ──────────────────────────────────────────────
// A row's day is read as a date axis reads it (categoryKey.parseDateCell), so `2024-01-31` and `01/31/2024` are one
// day. A row with no day is never kept. The doors find the day from a day-grain chart's labels and keep its rows with
// a `period` filter (ipc/snapshotDoors); `snapshotRows` is the row-level REFERENCE they are held equal to.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayOf(cell: Cell): number | null {
  const c = parseDateCell(cell);
  return c ? daysFromCivil(c.y, c.m, c.d) : null;
}

/**
 * The JS REFERENCE: the rows a snapshot keeps, those on the latest (or earliest) day of `snap.column`.
 * `partition` (a date bucket id) makes that day per bucket; absent, the whole table is one partition.
 */
export function snapshotRows(columns: ParsedColumn[], rows: Cell[][], snap: MetricSnapshot, partition?: (row: Cell[]) => string | null): Cell[][] {
  const at = columns.findIndex((c) => c.name === snap.column);
  if (at < 0) return [];
  const part = (row: Cell[]): string | null => (partition ? partition(row) : '');
  const best = new Map<string | null, number>();
  for (const row of rows) {
    const d = dayOf(row[at]);
    if (d === null) continue;
    const b = best.get(part(row));
    if (b === undefined || (snap.take === 'last' ? d > b : d < b)) best.set(part(row), d);
  }
  return rows.filter((row) => {
    const d = dayOf(row[at]);
    return d !== null && best.get(part(row)) === d;
  });
}

const later = (a: string, b: string, take: MetricSnapshot['take']): boolean => (take === 'last' ? a > b : a < b);

/** The latest (or earliest) of a day-grain axis's labels, or null. Only ISO day labels count (a blank or "Other" is no day). */
export function latestDay(labels: (string | number)[], take: MetricSnapshot['take']): string | null {
  let out: string | null = null;
  for (const l of labels) if (typeof l === 'string' && ISO_DAY.test(l) && (out === null || later(l, out, take))) out = l;
  return out;
}

/**
 * A day-grain reply rolled up to `grain` the snapshot way: each bucket shows ITS latest (or earliest) day's values, in
 * first-seen order. A series with no value on that day is null there, never an older day's (D8).
 */
export function pickPerBucket<D extends { labels: (string | number)[]; series: { name: string; values: (number | null)[] }[] }>(day: D, grain: DateGrain, take: MetricSnapshot['take']): D {
  const at = new Map<string, number>(); // bucket label → the index of its day
  day.labels.forEach((l, i) => {
    const c = typeof l === 'string' && ISO_DAY.test(l) ? parseDateCell(l) : null;
    if (!c) return;
    const bucket = dateBucketLabel(dateBucket(c, grain), grain);
    const j = at.get(bucket);
    if (j === undefined || later(l as string, day.labels[j] as string, take)) at.set(bucket, i);
  });
  const picked = [...at.values()];
  return { ...day, labels: [...at.keys()], series: day.series.map((s) => ({ ...s, values: picked.map((i) => s.values[i] ?? null) })) };
}

/** The filter that keeps one day's rows. */
export function onDay(column: string, day: string): FilterStep {
  return { type: 'filter', column, op: 'period', period: { preset: 'custom', from: day, to: day } };
}
