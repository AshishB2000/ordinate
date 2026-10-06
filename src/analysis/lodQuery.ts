// LOD expressions at QUERY time — MAIN PROCESS, PURE logic (no fs, DOM).
//
// A calculated field with an LOD is computed when the pipeline runs, at no
// visual's dimensions and before any dashboard exists. That stored column is
// right — and every resident fast path keeps reading it — until a query asks
// for something the stored value cannot know:
//
//   · a CONTEXT filter ("Apply before LOD") — it must narrow the rows the LOD
//     aggregates over, so the field is recomputed after it;
//   · an INCLUDE / EXCLUDE field in a visual — it groups relative to that
//     visual's dimensions, which only the query knows;
//   · a metric that aggregates an LOD directly — `sum({FIXED [Region] : …})`.
//
// Then the order is the one Tableau documents:
//
//   context filters → LOD aggregates → ordinary filters → the visual's aggregate
//
// which is why an ordinary filter does NOT change a FIXED value ("share of
// region" stays a share of the whole region) and a context filter does.
//
// Fields are recomputed in pipeline order, and a field that references one
// already recomputed is recomputed too, so `share = [Sales] / [region_total]`
// follows its LOD input. A field whose inputs a LATER step removed keeps its
// stored value.
// ponytail: the recompute reads the FINAL prepared table, so a Prepare filter
// placed after an LOD field is honoured here although the stored value was
// computed before it. Replaying the pipeline per query costs a full rebuild;
// revisit if anyone orders a filter after an LOD on purpose.
// ponytail: INCLUDE/EXCLUDE group by the visual's RAW dimension columns — a
// binned number or a month-grained date category is not re-bucketed first.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep, TableData, TransformStep } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import type { FValue } from '../formula/formula';
import { compile } from '../formula/formula';
import { evaluateTable, isLodExpression, lodDimProblem } from '../formula/lod';
import type { VizEncoding } from './visuals';
import { buildVizData } from './vizData';
import type { VizDataResult } from './vizData';
import { computeMetric } from './metricValue';
import type { MetricAggregation } from './metricValue';

export function splitContext(filters: FilterStep[] | null | undefined): { context: FilterStep[]; normal: FilterStep[] } {
  const list = Array.isArray(filters) ? filters : [];
  return { context: list.filter((f) => f && f.context === true), normal: list.filter((f) => f && f.context !== true) };
}

/** The dimensions a visual shows — what INCLUDE adds to and EXCLUDE removes from. */
export function vizDimsOf(encoding: VizEncoding | null | undefined): string[] {
  if (!encoding) return [];
  if (encoding.pivot) return encoding.pivot.rows.concat(encoding.pivot.columns).map((d) => d.column);
  if (encoding.cohort || encoding.eventFunnel) return [];
  const out = typeof encoding.category === 'string' && encoding.category ? [encoding.category] : [];
  if (typeof encoding.series === 'string' && encoding.series) out.push(encoding.series);
  return out;
}

interface LodField {
  name: string;
  expression: string;
  /** Holds an INCLUDE or EXCLUDE — depends on the visual's dimensions. */
  relative: boolean;
}

/** The pipeline's calculated fields that carry an LOD. */
export function lodFields(steps: TransformStep[] | null | undefined): LodField[] {
  const out: LodField[] = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || s.type !== 'calculated_field' || s.expression.indexOf('{') < 0) continue;
    const c = compile(s.expression);
    if (!c.ok || c.fn.lods.length === 0) continue;
    out.push({ name: s.name, expression: s.expression, relative: c.fn.lods.some((l) => l.kind !== 'fixed') });
  }
  return out;
}

/**
 * Does this query need the LOD pass at all? False is the common case, and it
 * keeps every resident fast path: a FIXED field under ordinary filters is
 * exactly its stored value.
 */
export function needsLodPass(
  steps: TransformStep[] | null | undefined,
  filters: FilterStep[],
  vizDims: string[],
  metricColumn?: string,
): boolean {
  if (metricColumn !== undefined && isLodExpression(metricColumn)) return true;
  const fields = lodFields(steps);
  if (fields.length === 0) return false;
  if (splitContext(filters).context.length > 0) return true;
  return vizDims.length > 0 && fields.some((f) => f.relative);
}

function stored(v: FValue, type: ParsedColumn['type']): Cell {
  if (v == null) return null;
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v) ? v : null;
  return String(v);
}

/**
 * Context filters, then every LOD field (and every field downstream of one)
 * recomputed at the visual's dimensions. Ordinary filters are the caller's.
 */
export function lodTable(
  table: TableData,
  steps: TransformStep[] | null | undefined,
  context: FilterStep[],
  vizDims: string[],
): { table: TableData; warnings: string[] } {
  const warnings: string[] = [];
  let t = table;
  if (context.length) {
    const f = applyPipeline(table, context);
    for (const w of f.warnings) warnings.push(w);
    t = { columns: f.columns, rows: f.rows };
  }
  const names = new Set(t.columns.map((c) => c.name));
  const changed = new Set<string>();
  let rows: Cell[][] | null = null;
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || s.type !== 'calculated_field') continue;
    const c = compile(s.expression);
    if (!c.ok) continue;
    if (c.fn.lods.length === 0 && !c.fn.refs.some((r) => changed.has(r))) continue;
    const ci = t.columns.findIndex((x) => x.name === s.name);
    if (ci < 0 || c.fn.refs.some((r) => !names.has(r))) continue;
    if (!rows) rows = t.rows.map((r) => r.slice());
    const vals = evaluateTable(c.fn, t.columns, rows, { vizDims });
    const type = t.columns[ci].type;
    for (let i = 0; i < rows.length; i += 1) rows[i][ci] = stored(vals[i], type);
    changed.add(s.name);
  }
  return { table: rows ? { columns: t.columns, rows } : t, warnings };
}

/** `buildVizData` with the LOD pass in front of it. */
export function lodVizData(
  columns: ParsedColumn[],
  rows: Cell[][],
  steps: TransformStep[] | null | undefined,
  encoding: VizEncoding,
  filters: FilterStep[],
): VizDataResult {
  const { context, normal } = splitContext(filters);
  const pass = lodTable({ columns, rows }, steps, context, vizDimsOf(encoding));
  const r = buildVizData(pass.table.columns, pass.table.rows, encoding, normal);
  return pass.warnings.length ? { ...r, warnings: pass.warnings.concat(r.warnings) } : r;
}

/** The column name an aggregated LOD is appended under — clear of every real one. */
function freeName(columns: ParsedColumn[]): string {
  let name = '__ordinate_lod';
  for (let n = 1; columns.some((c) => c.name === name); n += 1) name = `__ordinate_lod_${n}`;
  return name;
}

/**
 * A metric with the LOD pass in front of it. `spec.column` is a column — or,
 * from a metric formula's `sum({FIXED [Region] : SUM([Sales])})`, the LOD
 * expression itself, evaluated per row and then aggregated like a column.
 */
export function lodMetricValue(
  columns: ParsedColumn[],
  rows: Cell[][],
  steps: TransformStep[] | null | undefined,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[],
): number | null {
  const { context, normal } = splitContext(filters);
  let t = lodTable({ columns, rows }, steps, context, []).table;
  let column = spec.column;
  if (isLodExpression(spec.column)) {
    const c = compile(spec.column);
    if (!c.ok || lodDimProblem(c.fn, t.columns.map((x) => x.name))) return null;
    const vals = evaluateTable(c.fn, t.columns, t.rows);
    column = freeName(t.columns);
    t = {
      columns: t.columns.concat([{ name: column, type: 'number' }]),
      rows: t.rows.map((r, i) => r.concat([stored(vals[i], 'number')])),
    };
  }
  if (normal.length) t = applyPipeline(t, normal);
  return computeMetric(t.columns, t.rows, { column, aggregation: spec.aggregation });
}
