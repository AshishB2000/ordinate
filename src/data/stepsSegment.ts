// The `segment` prepare step — MAIN PROCESS, PURE: the JS REFERENCE for
// engine/sqlGenSegment.ts.
//
// "Save as column" in Find segments appends this step. It CARRIES the fitted
// model — per-feature mean and standard deviation, the centroids in
// standardised units, one name per centroid — and on every refresh assigns
// each row to its nearest centroid, writing the segment's NAME into a new
// TEXT column (so it is an ordinary dimension everywhere). The model is not
// refitted on refresh: a segment keeps meaning the same thing.
//
// A row with an empty or non-numeric value in ANY feature gets an empty cell
// — never a guessed segment. Only DECLARED number columns are features (the
// declared-type rule: '007' is text). Assignment is segmentMath.zScore +
// nearest, the same arithmetic the fit labelled its own sample with.
//
// A stored model is sanitised strictly (finite numbers, ≤ 8 centroids, ≤ 32
// features, std > 0, unique non-empty names); a malformed one is dropped by
// sanitize, and a step whose columns no longer fit SKIPS with a warning.

import type { Cell, TableData } from './transforms';
import { nearest, zScore } from '../analysis/segmentMath';

export const SEGMENT_MAX_FEATURES = 32;
export const SEGMENT_MIN_K = 2;
export const SEGMENT_MAX_K = 8;
const MAX_NAME = 80;
const MAX_COLUMN = 128;

export interface SegmentStep {
  type: 'segment';
  /** The new text column. */
  column: string;
  features: string[];
  means: number[];
  stds: number[];
  /** k × features, in standardised units. */
  centroids: number[][];
  /** One per centroid. */
  names: string[];
}

interface ColLike {
  name: string;
  type: string;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function cleanName(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= max ? s : null;
}

/** True when the arrays agree in shape and every number is usable. */
export function modelOk(s: SegmentStep): boolean {
  const f = Array.isArray(s.features) ? s.features.length : 0;
  const k = Array.isArray(s.centroids) ? s.centroids.length : 0;
  return f >= 1 && f <= SEGMENT_MAX_FEATURES && k >= SEGMENT_MIN_K && k <= SEGMENT_MAX_K
    && Array.isArray(s.means) && s.means.length === f && s.means.every(finite)
    && Array.isArray(s.stds) && s.stds.length === f && s.stds.every((x) => finite(x) && x > 0)
    && s.centroids.every((c) => Array.isArray(c) && c.length === f && c.every(finite))
    && Array.isArray(s.names) && s.names.length === k && new Set(s.names).size === k
    && s.names.every((n) => cleanName(n, MAX_NAME) === n)
    && new Set(s.features).size === f && s.features.every((n) => typeof n === 'string' && n.length > 0);
}

/** Untrusted → a clean step, or null. Nothing is repaired: a bad model is dropped. */
export function sanitizeSegmentStep(o: Record<string, unknown>): SegmentStep | null {
  const column = cleanName(o.column, MAX_COLUMN);
  if (!column) return null;
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const step: SegmentStep = {
    type: 'segment',
    column,
    features: arr(o.features).map((x) => (typeof x === 'string' ? x : '')),
    means: arr(o.means) as number[],
    stds: arr(o.stds) as number[],
    centroids: arr(o.centroids).map((c) => arr(c) as number[]),
    names: arr(o.names).map((x) => cleanName(x, MAX_NAME) || ''),
  };
  if (!modelOk(step)) return null;
  return {
    ...step,
    features: step.features.slice(),
    means: step.means.slice(),
    stds: step.stds.slice(),
    centroids: step.centroids.map((c) => c.slice()),
    names: step.names.slice(),
  };
}

/** Why this step cannot run on these columns, or null. The fold and SQL share the text. */
export function segmentProblem(columns: ColLike[], s: SegmentStep): string | null {
  const column = typeof s.column === 'string' ? s.column.trim() : '';
  if (!column) return 'Segment skipped: blank column name';
  if (!modelOk(s)) return 'Segment skipped: the stored model is not valid';
  if (columns.some((c) => c.name === column)) return `Segment skipped: column "${column}" already exists`;
  const missing = s.features.filter((f) => !columns.some((c) => c.name === f));
  if (missing.length) return `Segment skipped: unknown column(s): ${missing.join(', ')}`;
  const notNum = s.features.filter((f) => columns.find((c) => c.name === f)?.type !== 'number');
  if (notNum.length) return `Segment skipped: not a number column: ${notNum.join(', ')}`;
  return null;
}

/**
 * The segment index for one row's feature cells, or -1 when any cell is not a
 * finite number. `z` is scratch space, one slot per feature.
 */
export function assignCells(cells: Cell[], s: SegmentStep, z: Float64Array): number {
  for (let j = 0; j < cells.length; j++) {
    const v = cells[j];
    if (typeof v !== 'number' || !Number.isFinite(v)) return -1;
    z[j] = zScore(v, s.means[j], s.stds[j]);
  }
  return nearest(z, s.centroids);
}

/** Feature positions in `columns` (first match), in the step's feature order. */
export function featureIndexes(columns: ColLike[], s: SegmentStep): number[] {
  return s.features.map((f) => columns.findIndex((c) => c.name === f));
}

export function applySegmentStep(t: TableData, s: SegmentStep): { table: TableData; warnings: string[] } {
  const problem = segmentProblem(t.columns, s);
  if (problem) return { table: t, warnings: [problem] };
  const idx = featureIndexes(t.columns, s);
  const z = new Float64Array(idx.length);
  const cells: Cell[] = new Array(idx.length);
  const rows = t.rows.map((r) => {
    for (let j = 0; j < idx.length; j++) cells[j] = r[idx[j]] ?? null;
    const k = assignCells(cells, s, z);
    return [...r, k < 0 ? null : s.names[k]];
  });
  const columns = [...t.columns.map((c) => ({ ...c })), { name: s.column.trim(), type: 'text' as const }];
  return { table: { columns, rows }, warnings: [] };
}
