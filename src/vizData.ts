// PURE visualization bridge — MAIN PROCESS, no Electron / fs / DOM.
// buildVizData turns a user encoding (a dimension + one or more measures, an
// optional split, an optional geo level) over a dataset's columns/rows into the
// EXACT `{labels, series}` (+ optional `geo`) object the existing renderers
// (chartRender.buildChart / mapRender.renderMapInArea) already consume — so
// Week 7 adds NOTHING to the renderers.
//
// Number-accuracy is preserved because NO model is involved: every value cell is
// either an app-computed `group_aggregate` output (the SAME arithmetic the Prepare
// pipeline uses) or a verbatim numeric dataset cell; a non-numeric cell becomes
// `null` (never a string, never a re-stringified figure).

import type { ParsedColumn } from './data/parse';
import type { Cell, FilterStep, TableData } from './data/transforms';
import { applyPipeline } from './data/transforms';
import type { VizEncoding, VizMeasure } from './visuals';

// === the buildChart input shape (chartRender.ts). A series is "plottable" when
// values is a non-empty array; non-numeric cells MUST be null (the renderers test
// `typeof v === 'number'` everywhere).
export interface ChartData {
  labels: (string | number)[];
  series: { name: string; values: (number | null)[] }[];
}

export interface VizDataResult {
  data: ChartData & {
    // superset: also carries geo for map chart types (mapRender.ts)
    geo?: { level: string; items: { name: string; value: number }[] };
    dataShape?: 'time_series';
  };
  recommendedShape: string; // feeds the renderer's eligibleChartTypes()
  warnings: string[];
}

// ── small pure helpers ───────────────────────────────────────────────────────

function colIndex(columns: ParsedColumn[], name: string): number {
  return columns.findIndex((c) => c.name === name);
}

// A value cell → number or null. The strict rule: only a finite JS number passes;
// everything else (string, null, NaN, Infinity) becomes null so the renderer never
// sees a non-number where it expects one.
function numOrNull(cell: Cell): number | null {
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
}

// A category/label cell → string|number, verbatim. A leading-zero id stored as
// text ("007") stays the string "007"; a numeric label stays a number.
function labelVal(cell: Cell): string | number {
  if (typeof cell === 'number') return cell;
  return cell == null ? '' : String(cell);
}

// Stable key for grouping label/series cells by identity (type-aware).
function keyOf(cell: Cell): string {
  return JSON.stringify(cell == null ? null : cell);
}

// Display-only series name. Aggregated → "sum of price"; count / raw (`none`) /
// single verbatim column → just the column name.
function measureLabel(v: VizMeasure): string {
  if (v.aggregation === 'none' || v.aggregation === 'count') return v.column;
  return `${v.aggregation} of ${v.column}`;
}

// ── recommendChartType ───────────────────────────────────────────────────────
// Pure classification → a dataShape key the renderer already maps to best-first
// charts via SHAPE_CHARTS/eligibleChartTypes. Only columns + encoding are known
// here (no rows), so single_metric is left to buildVizData to refine.
const SHAPE_DEFAULT_TYPE: Record<string, string> = {
  time_series: 'line',
  categorical: 'column',
  part_to_whole: 'pie',
  single_metric: 'gauge',
  map_choropleth: 'map_choropleth',
  map_bubble: 'map_bubble',
};

export function recommendChartType(
  columns: ParsedColumn[],
  encoding: VizEncoding,
): { shape: string; type: string } {
  if (encoding.geo) {
    // (bubble only when the category column carries lat/lng point data — not
    // detectable from a single dimension column, so default to choropleth.)
    return { shape: 'map_choropleth', type: SHAPE_DEFAULT_TYPE.map_choropleth };
  }
  const catCol = columns.find((c) => c.name === encoding.category);
  const hasSplit = typeof encoding.series === 'string' && encoding.series.length > 0;
  if (catCol && catCol.type === 'date') return { shape: 'time_series', type: SHAPE_DEFAULT_TYPE.time_series };
  if (hasSplit) return { shape: 'categorical', type: 'clustered_column' };
  const nMeasures = Array.isArray(encoding.values) ? encoding.values.length : 0;
  if (nMeasures === 0) return { shape: 'single_metric', type: SHAPE_DEFAULT_TYPE.single_metric };
  return { shape: 'categorical', type: SHAPE_DEFAULT_TYPE.categorical };
}

// ── buildVizData ─────────────────────────────────────────────────────────────

function emptyResult(columns: ParsedColumn[], encoding: VizEncoding, warning: string): VizDataResult {
  return {
    data: { labels: [], series: [] },
    recommendedShape: recommendChartType(columns, encoding).shape,
    warnings: [warning],
  };
}

// (A) No split, aggregated: one group_aggregate over the category, one output
// series per measure. labels = the category column of the aggregated output.
function buildAggregated(
  table: TableData,
  encoding: VizEncoding,
  warnings: string[],
): ChartData {
  const step = {
    type: 'group_aggregate' as const,
    groupBy: [encoding.category],
    aggregations: encoding.values.map((v, i) => ({
      column: v.column,
      fn: (v.aggregation === 'none' ? 'sum' : v.aggregation) as 'sum' | 'avg' | 'count' | 'min' | 'max',
      as: `m${i}`,
    })),
  };
  const out = applyPipeline(table, [step]);
  for (const w of out.warnings) warnings.push(w);

  const labels = out.rows.map((r) => labelVal(r[0]));
  const series = encoding.values.map((v, i) => ({
    // In an aggregated (grouped) build a 'none' measure is summed (above), so
    // label it as such ("sum of price") rather than the bare column name, which
    // would understate what the value actually is.
    name: measureLabel(v.aggregation === 'none' ? { ...v, aggregation: 'sum' } : v),
    values: out.rows.map((r) => numOrNull(r[1 + i])),
  }));
  return { labels, series };
}

// (B) Split/pivot: group by category × series, single measure, then long→wide
// pivot. Missing (category, series) combos → null.
function buildPivot(
  table: TableData,
  encoding: VizEncoding,
  warnings: string[],
): ChartData {
  const agg0 = encoding.values[0];
  const step = {
    type: 'group_aggregate' as const,
    groupBy: [encoding.category, encoding.series as string],
    aggregations: [
      {
        column: agg0.column,
        fn: (agg0.aggregation === 'none' ? 'sum' : agg0.aggregation) as 'sum' | 'avg' | 'count' | 'min' | 'max',
        as: 'm0',
      },
    ],
  };
  const out = applyPipeline(table, [step]);
  for (const w of out.warnings) warnings.push(w);

  const labels: (string | number)[] = [];
  const catIdx = new Map<string, number>();
  const serVals: (string | number)[] = [];
  const serIdx = new Map<string, number>();
  for (const r of out.rows) {
    const ck = keyOf(r[0]);
    if (!catIdx.has(ck)) { catIdx.set(ck, labels.length); labels.push(labelVal(r[0])); }
    const sk = keyOf(r[1]);
    if (!serIdx.has(sk)) { serIdx.set(sk, serVals.length); serVals.push(labelVal(r[1])); }
  }
  const series = serVals.map((sv) => ({
    name: String(sv),
    values: labels.map(() => null as number | null),
  }));
  for (const r of out.rows) {
    const ci = catIdx.get(keyOf(r[0]));
    const si = serIdx.get(keyOf(r[1]));
    if (ci === undefined || si === undefined) continue;
    series[si].values[ci] = numOrNull(r[2]);
  }
  return { labels, series };
}

// (C) Raw, no aggregation: each row is a point. labels = raw category cells;
// series[i] = the raw numeric cells of measure i (non-numeric → null).
function buildRaw(
  table: TableData,
  encoding: VizEncoding,
): ChartData {
  const catIdx = colIndex(table.columns, encoding.category);
  const labels = table.rows.map((r) => labelVal(catIdx >= 0 ? r[catIdx] : null));
  const series = encoding.values.map((v) => {
    const ci = colIndex(table.columns, v.column);
    return {
      name: v.column,
      values: table.rows.map((r) => (ci >= 0 ? numOrNull(r[ci]) : null)),
    };
  });
  return { labels, series };
}

// PURE: dataset columns + rows + a user encoding → the EXACT renderer input shape.
// Never throws — a missing category / no measure / unknown column yields a clear,
// empty result with a warning.
export function buildVizData(
  columns: ParsedColumn[],
  rows: Cell[][],
  encoding: VizEncoding,
  filters?: FilterStep[],
): VizDataResult {
  const cols = Array.isArray(columns) ? columns : [];
  let table: TableData = { columns: cols, rows: Array.isArray(rows) ? rows : [] };

  if (!encoding || typeof encoding.category !== 'string' || encoding.category === '') {
    return emptyResult(cols, encoding, 'No category (dimension) selected.');
  }
  if (colIndex(cols, encoding.category) < 0) {
    return emptyResult(cols, encoding, `Unknown category column "${encoding.category}".`);
  }
  const values = Array.isArray(encoding.values) ? encoding.values : [];
  if (values.length === 0) {
    return emptyResult(cols, encoding, 'No measure selected.');
  }

  const warnings: string[] = [];

  // Visual-level filters run FIRST, over the raw rows, BEFORE any aggregation —
  // so every downstream figure is computed from the filtered subset by the SAME
  // tested pure pipeline (number-accuracy preserved; a non-numeric cell still
  // becomes null, never a fabricated figure). Omitted/empty → identical to today.
  if (filters && filters.length > 0) {
    const filtered = applyPipeline(table, filters);
    for (const w of filtered.warnings) warnings.push(w);
    table = { columns: filtered.columns, rows: filtered.rows };
  }

  const hasSplit = typeof encoding.series === 'string' && encoding.series.length > 0;
  const allNone = values.every((v) => v.aggregation === 'none');

  let chart: ChartData;
  if (hasSplit) {
    chart = buildPivot(table, encoding, warnings); // (B)
  } else if (allNone) {
    chart = buildRaw(table, encoding); // (C)
  } else {
    chart = buildAggregated(table, encoding, warnings); // (A)
  }

  const data: VizDataResult['data'] = { labels: chart.labels, series: chart.series };

  // Geo: build labels/series exactly as above, then derive region items from the
  // first series. A split (2+ series) also keeps labels+series + dataShape so the
  // map's period stepping (buildPeriodGeo) works for free.
  if (encoding.geo) {
    const first = chart.series[0];
    // Only emit regions that actually have a numeric value — a no-data region is
    // OMITTED (renders blank on the choropleth) rather than fabricated as 0, so
    // "no data" is never conflated with a real zero (number-honesty).
    const items: { name: string; value: number }[] = [];
    chart.labels.forEach((name, k) => {
      const v = first ? first.values[k] : null;
      if (typeof v === 'number') items.push({ name: String(name), value: v });
    });
    data.geo = { level: encoding.geo.level, items };
    if (chart.series.length >= 2) data.dataShape = 'time_series';
  }

  const recommendedShape = recommendChartType(cols, encoding).shape;
  return { data, recommendedShape, warnings };
}
