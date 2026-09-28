// The ten "power" prepare steps — their SHAPES, the pipeline context they read,
// and the per-step row counts. MAIN PROCESS, PURE (types + constants only).
//
// transforms.ts owns the fold; these types join its TransformStep union through
// one `| PowerStep` line, so that file only gains the union member, the
// STEP_TYPES entries and the dispatch lines (a concurrent branch edits it too).
//
// Decisions pinned here, because every engine (JS fold, sqlGen, the editors)
// must agree on them:
//   · dedupe-by-key is its OWN step (`dedupe_key`), not optional fields on
//     `dedupe` — the old step, its SQL and its tests stay byte-for-byte as they were.
//   · union DROPS the other dataset's unmatched columns (this dataset's schema is
//     what later steps reference); the editor lists what will be dropped.
//   · unpivot is ROW-MAJOR: each input row becomes N consecutive rows, in the
//     step's column order (the Power Query / Tableau order).
//   · lookup_join with a non-unique right key WARNS and takes the first match in
//     stored order — the same rule joinJs uses for a relationship hop.
//   · replace_values `exact`: the first matching rule wins; `contains`/`regex`:
//     every rule rewrites the result of the one before, in order.

import type { AggFn, TableData } from './transforms';
import type { BoundaryIndex } from '../analysis/geo/pip';

export const POWER_STEP_TYPES: ReadonlySet<string> = new Set([
  'split_column',
  'unpivot',
  'pivot',
  'parse_date',
  'dedupe_key',
  'replace_values',
  'conditional_column',
  'union',
  'lookup_join',
  'window',
  'spatial_join', // r6:geo
]);

/** Split one column by a delimiter, fixed positions or a regex; into N columns or into rows. */
export interface SplitColumnStep {
  type: 'split_column';
  column: string;
  mode: 'delimiter' | 'position' | 'regex';
  delimiter?: string;
  /** Cut points, in CHARACTERS (code points), strictly ascending, each > 0. */
  positions?: number[];
  /** A pattern from the JS/RE2 common subset (src/data/regexSubset.ts). */
  pattern?: string;
  ignoreCase?: boolean;
  into: 'columns' | 'rows';
  /** into 'columns': how many — `<col>_1 … <col>_N`, missing parts null. */
  count?: number;
}

/** Chosen columns become (attribute, value) rows. */
export interface UnpivotStep {
  type: 'unpivot';
  columns: string[];
  attribute?: string;
  value?: string;
}

/** A key column's distinct values become columns, aggregating a value column. */
export interface PivotStep {
  type: 'pivot';
  key: string;
  value: string;
  fn: AggFn;
  groupBy: string[];
}

/** Parse text to ISO dates with ONE explicit format; failures become null. */
export interface ParseDateStep {
  type: 'parse_date';
  column: string;
  format: string;
  /** Write to a new column instead of replacing `column` in place. */
  as?: string;
}

/** Keep one row per key: the first, the last, or the one with the max/min of `by`. */
export interface DedupeKeyStep {
  type: 'dedupe_key';
  columns: string[];
  keep: 'first' | 'last' | 'max' | 'min';
  by?: string;
}

export interface ReplaceRule {
  from: string;
  to: string;
}
export interface ReplaceValuesStep {
  type: 'replace_values';
  column: string;
  mode: 'exact' | 'contains' | 'regex';
  rules: ReplaceRule[];
  ignoreCase?: boolean;
}

export type RuleOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'contains' | 'is_empty' | 'not_empty';
export interface ConditionalRule {
  when: { column: string; op: RuleOp; value?: string | number };
  /** Always text (or null): the result column is typed from the data afterwards. */
  then: string | null;
}
/** IF → value rules, compiled to ONE formula and run by the calculated-field machinery. */
export interface ConditionalColumnStep {
  type: 'conditional_column';
  name: string;
  rules: ConditionalRule[];
  else?: string | null;
}

/** Append another dataset's rows, matching columns by name (+ an explicit mapping). */
export interface UnionStep {
  type: 'union';
  datasetId: string;
  /** Other-dataset column `from` fills this dataset's column `to`. */
  mapping?: Array<{ from: string; to: string }>;
}

/** A many-to-one join to another dataset's key, bringing chosen columns across. */
export interface LookupJoinStep {
  type: 'lookup_join';
  datasetId: string;
  leftKey: string;
  rightKey: string;
  columns: string[];
  prefix?: string;
}

export type WindowFn = 'row_number' | 'lag' | 'lead' | 'running_sum' | 'running_avg';
export interface WindowStep {
  type: 'window';
  fn: WindowFn;
  as: string;
  /** The value column — lag/lead/running_sum/running_avg. */
  column?: string;
  /** lag/lead distance, 1…1000. */
  offset?: number;
  partitionBy?: string[];
  /** Omitted: the stored row order. Ties always break on the stored order. */
  orderBy?: string;
  desc?: boolean;
}

/**
 * r6:geo — assign each point to the region containing it (point in polygon
 * over a bounding-box index, src/analysis/geo/pip.ts), writing the region's
 * name into a new text column. Boundaries are the bundled US states /
 * countries / US counties, or a project's own imported set by id, named by
 * one of its properties. Loaded by main before the fold (stepRefs.ts).
 */
export interface SpatialJoinStep {
  type: 'spatial_join';
  lat: string;
  lng: string;
  boundary: 'us_state' | 'country' | 'us_county' | 'custom';
  /** `custom`: the project boundary set and the property that names a region. */
  boundaryId?: string;
  property?: string;
  /** The new column — `region` unless named. */
  as: string;
  /** What a point in no region (or with no usable coordinates) gets — '' unless set. */
  unmatched: string;
}

export type PowerStep =
  | SplitColumnStep
  | UnpivotStep
  | PivotStep
  | ParseDateStep
  | DedupeKeyStep
  | ReplaceValuesStep
  | ConditionalColumnStep
  | UnionStep
  | LookupJoinStep
  | WindowStep
  | SpatialJoinStep;

/**
 * What a pure fold needs from OUTSIDE its own table: the other datasets a
 * union/lookup step names, loaded by main BEFORE the fold runs
 * (src/data/stepRefs.ts). `errors` says why a reference was withheld (a cycle,
 * itself, not found) — the step skips with that reason.
 */
export interface PipelineContext {
  tables: Record<string, TableData>;
  errors?: Record<string, string>;
  /**
   * r6:geo — the boundary sets spatial_join steps read, indexed, keyed by
   * `spatialKey(step)`; a string is why that set could not be loaded.
   */
  boundaries?: Record<string, BoundaryIndex | string>;
}

/** Rows into and out of one step, index-aligned with the step list. */
export interface StepCount {
  before: number;
  after: number;
}

// ponytail: fixed caps; each is a number a user can see in a warning.
export const MAX_SPLIT_PARTS = 50;
export const MAX_PIVOT_COLUMNS = 100;
export const MAX_RULES = 100;
export const MAX_WINDOW_OFFSET = 1000;

/** Why a union/lookup reference is not usable, or null when its table is loaded. */
export function refProblem(ctx: PipelineContext | undefined, id: string): string | null {
  if (ctx && ctx.errors && typeof ctx.errors[id] === 'string') return ctx.errors[id];
  if (ctx && ctx.tables && ctx.tables[id]) return null;
  return 'the other dataset is not loaded';
}

/** The dataset ids a step list reads besides its own source, first-seen order. */
export function stepRefIds(steps: ReadonlyArray<{ type?: unknown; datasetId?: unknown }> | undefined): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || (s.type !== 'union' && s.type !== 'lookup_join')) continue;
    if (typeof s.datasetId === 'string' && !out.includes(s.datasetId)) out.push(s.datasetId);
  }
  return out;
}
