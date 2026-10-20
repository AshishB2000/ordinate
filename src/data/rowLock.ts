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
 * Steps whose output row is computed from that input row alone (or that only
 * drop rows): they cannot carry one customer's value into another's row. An
 * ALLOW-list — a step type added later is cross-row until it is classified here
 * (docs/row-policy/00-design.md D16). `union` appends another dataset's rows as
 * they are; LOD calculated fields are caught by `lodFields` below.
 */
export const ROW_LOCAL: ReadonlySet<string> = new Set([
  'calculated_field', 'filter', 'fill_empty', 'trim', 'drop_column', 'rename_column',
  'mask_hash', 'mask_redact', 'mask_generalize',
  'split_column', 'unpivot', 'parse_date', 'replace_values', 'conditional_column', 'union', 'spatial_join',
  'text_sentiment', 'keyword_rules',
]);

/** Steps that combine rows by key: row-local only when every locked column is part of the key. */
export const KEYED: Readonly<Record<string, (s: Record<string, unknown>) => readonly unknown[] | undefined>> = {
  window: (s) => (Array.isArray(s.partitionBy) ? s.partitionBy : []),
  group_aggregate: (s) => (Array.isArray(s.groupBy) ? s.groupBy : []),
  pivot: (s) => (Array.isArray(s.groupBy) ? s.groupBy : []),
  dedupe_key: (s) => (Array.isArray(s.columns) ? s.columns : []),
  // A dedupe with no columns compares whole rows, the locked columns included.
  dedupe: (s) => (Array.isArray(s.columns) ? s.columns : undefined),
};

/** Steps that always store a cross-row value (a clustering, a corpus's terms, another dataset's columns joined by key). */
export const CROSS_ROW_STEPS: ReadonlySet<string> = new Set(['segment', 'text_terms', 'lookup_join']);

/** Origins whose stored rows were computed from other tables' rows: a query, a notebook cell, a join or append. */
const CROSS_ROW_ORIGINS: ReadonlySet<string> = new Set(['sql', 'notebook', 'composed', 'combined']);

/**
 * Does a dataset's pipeline (or the origin it was built from) store a value
 * computed across rows — so over every customer? A window, group-by, pivot or
 * dedupe keyed by every locked column stays inside one customer's rows.
 * `segment`, `text_terms`, `lookup_join`, LOD fields and any unknown step
 * type do not; neither does a dataset built by SQL, a notebook or the composer.
 */
export function storesCrossRow(steps: readonly TransformStep[] | undefined, locked: readonly string[], origin?: { kind?: unknown } | null): boolean {
  if (origin && typeof origin.kind === 'string' && CROSS_ROW_ORIGINS.has(origin.kind)) return true;
  const list = Array.isArray(steps) ? steps : [];
  const crosses = (step: TransformStep): boolean => {
    const s = step as unknown as Record<string, unknown>;
    const t = typeof s.type === 'string' ? s.type : '';
    if (ROW_LOCAL.has(t)) return false;
    const keyOf = Object.prototype.hasOwnProperty.call(KEYED, t) ? KEYED[t] : undefined;
    if (!keyOf) return true;
    const key = keyOf(s);
    return key !== undefined && !locked.every((c) => key.includes(c));
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
          (meta) => !!meta && cols.every((c) => meta.columns.some((x) => x.name === c)) && !storesCrossRow(meta.steps, cols, meta.origin),
          () => false,
        );
        seen.set(key, hit);
      }
      return hit;
    },
  };
}
