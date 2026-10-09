// "Column missing" — a Live question that names a column the warehouse no
// longer has (docs/live-data/00-plan.md L2.5) — PURE.
//
// A schema sync (./schemaSync.ts) that finds a column gone takes it out of the
// record's declared columns and remembers it in `live.missingColumns` while a
// chart, a KPI or a metric still names it. Without this, such a question would
// be refused as "not a column of this dataset" — or, for a filter, SKIPPED
// with a warning (the extract's rule for a dashboard filter spanning datasets),
// quietly drawing a different figure. The executor asks here first, so the
// question is refused saying exactly what happened, typed (`columnMissing`),
// before anything is compiled or sent.
//
// The names a question reads are the ones lineage reads off a visual
// (analysis/lineage `visualColumns`): category, split, measures, pivot fields
// and every filter — a dashboard's merged in.

import type { AnswerSpec } from '../../ai/answerSpec';
import type { VizEncoding } from '../../analysis/visuals';
import { visualColumns } from '../../analysis/lineage';
import type { FilterStep } from '../../data/transforms';
import type { LiveRefusal } from './liveSpec';
import { refuse } from './liveSpec';

/** The columns a chart reads: its encoding and its filters. */
export function encodingNames(encoding: VizEncoding, filters: FilterStep[]): string[] {
  return visualColumns({ encoding: encoding || {}, filters: Array.isArray(filters) ? filters : [] });
}

/** The columns a KPI reads: its measure and its filters. */
export function metricNames(spec: { column: string }, filters: FilterStep[]): string[] {
  return [spec && spec.column, ...(Array.isArray(filters) ? filters : []).map((f) => f && f.column)].filter((n): n is string => typeof n === 'string' && n !== '');
}

/** The columns an answer reads: category, measures, split and filters. */
export function answerNames(spec: AnswerSpec): string[] {
  if (!spec || typeof spec !== 'object') return [];
  const names = [spec.category, spec.series, ...(spec.measures || []).map((m) => m && m.column), ...(spec.filters || []).map((f) => f && f.column)];
  return names.filter((n): n is string => typeof n === 'string' && n !== '');
}

/** The refusal for the first named column the warehouse dropped, or null when none is. */
export function missingRefusal(missing: readonly string[] | undefined, names: readonly string[]): LiveRefusal | null {
  if (!missing || missing.length === 0) return null;
  const gone = new Set(missing);
  const hit = names.find((n) => gone.has(n));
  return hit === undefined ? null : refuse('columnMissing', hit);
}
