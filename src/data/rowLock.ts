// A lock: columns held to values, enforced in the data path — MAIN PROCESS.
//
// The core of an embed token's locked filters (docs/embed/00-design.md) and of a
// viewer's row access rules (docs/row-policy/00-design.md D1): one mechanism.
// Each locked column is ONE filter step (`=` for a value, `in` for several) with
// `context: true`, so it applies before LOD expressions too, placed FIRST in a
// filter list. A dataset that cannot honour a lock is refused, never read:
//
//   - it lacks a locked column — the pipeline SKIPS a filter on a column it
//     does not have (transforms.ts stepFilter), which would draw the unscoped
//     figure;
//   - its prepare steps STORE a value computed across rows (`storesCrossRow`) —
//     that value was computed over every row before any filter.
//
// No import of the chart door or of the dataset store at load time: the dataset
// layer (rowAccess.ts, which datasets.ts calls) builds on this file.

import { paramRefs } from '../analysis/params';
import { lodFields } from '../analysis/lodQuery';
import type { FilterStep, TransformStep } from './transforms';

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

/** The lock for `values`, or null when it locks nothing. Throws on an empty or parameterised value list. */
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
        // Lazy: the dataset store calls into this layer, so it is not imported at load time.
        const datasets = require('./datasets') as typeof import('./datasets');
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
