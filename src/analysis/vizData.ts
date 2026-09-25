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

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep, TableData } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import type { VizEncoding, VizMeasure } from './visuals';
import {
  CATEGORY_CAP, DATE_GRAINS, OTHER_LABEL, OTHER_NOTE,
  binIndex, binLabel, binPlan, chooseGrain, dateBucket, dateBucketLabel, isDateGrain, parseDateCell,
} from './categoryKey';
import type { CategoryInfo, CivilDate, DateGrain } from './categoryKey';
import { buildPivotGrid, pivotChartData } from './pivotData';
import type { PivotGrid } from './pivotData';

// === the buildChart input shape (chartRender.ts). A series is "plottable" when
// values is a non-empty array; non-numeric cells MUST be null (the renderers test
// `typeof v === 'number'` everywhere).
export interface ChartData {
  labels: (string | number)[];
  /** `role: 'overlay'` marks a comparison series (a prior period) — drawn muted. */
  series: { name: string; values: (number | null)[]; role?: 'overlay' }[];
}

export interface VizDataResult {
  data: ChartData & {
    // superset: also carries geo for map chart types (mapRender.ts)
    geo?: { level: string; items: { name: string; value: number }[] };
    dataShape?: 'time_series';
    /**
     * The PIVOT grid, present only for a pivot encoding. It rides ALONGSIDE
     * `labels`/`series` rather than replacing them (those are the grid's leaf
     * rows — see `pivotData.pivotChartData`), which is why a pivot needs no new
     * IPC channel, no new dashboard card type and no change to captions, the
     * filter bar, thumbnails or the share export: every one of them reads the
     * payload it already read.
     */
    pivot?: PivotGrid;
  };
  recommendedShape: string; // feeds the renderer's eligibleChartTypes()
  warnings: string[];
  /**
   * How the category axis was bucketed (see ./categoryKey). Absent on a raw
   * (all-'none') build and on maps, which are not grouped by this file's rules.
   *
   * `note` is a ready-to-show inline note and deliberately NOT a warning:
   * `ipc/visuals.residentVizData` proves the fast path is taken only when
   * `warnings` would be EMPTY, so pushing a note there would kill it.
   */
  category?: CategoryInfo;
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
//
// "Pivot" here is the long→wide RESHAPE that turns a split into one series per
// split value. It is not the `pivot` CHART TYPE — that is branch (D) above and
// lives in ./pivotData.
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

// ── The category key rewrite (branches A and B) ──────────────────────────────
//
// A Category on a high-cardinality column draws thousands of unreadable marks.
// The fix belongs HERE, in the one pure function every caller of `visual:data`
// routes through, rather than in a renderer: the builder, dashboard tiles,
// thumbnails, the share export and the Assistant's proposals all get it at once.
//
// The rewrite APPENDS a key column and re-points `encoding.category` at it; it
// never overwrites the source column, because a measure is allowed to aggregate
// the very column being grouped (`count` of the category is the common case)
// and it must still see the original cells. That is also exactly what the SQL
// path does — key expression and aggregates read the same physical column
// independently — so the two stay structurally aligned.
//
// Every decision and every label comes from ./categoryKey, which the resident
// path calls too. Nothing is formatted twice.

interface CategoryRewrite {
  table: TableData;
  encoding: VizEncoding;
  info: CategoryInfo;
  /**
   * Bucket KEY → axis label, applied after grouping. Only numeric binning needs
   * it, and it is the reason the label is not the key: two bins can compact to
   * the same text, and they must still be two groups (see `rewriteCategory`).
   * That split — SQL/JS group on an id, `categoryKey` writes the text — is
   * exactly what `residentCategory.catLabel` does on the other path.
   */
  relabel?: (label: string | number) => string | number;
}

const KEY_COL = '__ordinate_category';

function keyColumnName(columns: ParsedColumn[]): string {
  let name = KEY_COL;
  for (let n = 1; columns.some((c) => c && c.name === name); n += 1) name = `${KEY_COL}_${n}`;
  return name;
}

function appendKey(
  table: TableData,
  encoding: VizEncoding,
  keyed: Cell[],
): { table: TableData; encoding: VizEncoding } {
  const name = keyColumnName(table.columns);
  // 'text' whatever the source was: a bin label and a grain label are strings,
  // and a `number`-typed key column would send '0–1.2K' through coerceValue and
  // collapse every bucket into one null group.
  const columns = table.columns.concat([{ name, type: 'text' }]);
  const rows = table.rows.map((r, i) => r.concat([keyed[i]]));
  return { table: { columns, rows }, encoding: { ...encoding, category: name } };
}

/** Distinct non-null bucket count per grain → the finest grain that fits. */
function defaultGrain(parsed: (CivilDate | null)[]): DateGrain {
  const counts = {} as Record<DateGrain, number>;
  for (const g of DATE_GRAINS) {
    const seen = new Set<number>();
    for (const p of parsed) if (p) seen.add(dateBucket(p, g));
    counts[g] = seen.size;
  }
  return chooseGrain(counts);
}

/**
 * Text: keep the CATEGORY_CAP keys with the largest first measure, fold the
 * rest into one 'Other' group.
 *
 * The fold happens BEFORE aggregation, on the rows, so 'Other' is a real
 * re-aggregation of its rows. Folding already-aggregated numbers would be right
 * for `sum`/`count` and silently wrong for `avg` (a mean of means) and for
 * `min`/`max` over an empty tail.
 */
function capText(
  table: TableData,
  encoding: VizEncoding,
  cells: Cell[],
): CategoryRewrite {
  const distinct = new Set<string>();
  for (const c of cells) distinct.add(keyOf(c));
  if (distinct.size <= CATEGORY_CAP) return { table, encoding, info: { kind: 'text' } };

  const m0 = encoding.values[0];
  const probe = applyPipeline(table, [
    {
      type: 'group_aggregate' as const,
      groupBy: [encoding.category],
      aggregations: [
        {
          column: m0.column,
          fn: (m0.aggregation === 'none' ? 'sum' : m0.aggregation) as 'sum' | 'avg' | 'count' | 'min' | 'max',
          as: 'm0',
        },
      ],
    },
  ]);
  // The probe's warnings are the SAME ones the real build is about to push —
  // same step, same columns — so they are dropped rather than duplicated.

  // Descending by value with nulls last, ties broken by first-seen ordinal:
  // `probe.rows` is already in first-seen order, so the index IS the ordinal.
  // The SQL twin is `ORDER BY <m0> DESC NULLS LAST, min(<ordinal>)`.
  const ranked = probe.rows.map((r, i) => ({ key: keyOf(r[0]), v: numOrNull(r[1]), i }));
  ranked.sort((a, b) => {
    if (a.v === null || b.v === null) {
      if (a.v !== b.v) return a.v === null ? 1 : -1;
    } else if (a.v !== b.v) {
      return b.v - a.v;
    }
    return a.i - b.i;
  });
  const keep = new Set(ranked.slice(0, CATEGORY_CAP).map((r) => r.key));

  const keyed = cells.map((c) => (keep.has(keyOf(c)) ? c : OTHER_LABEL));
  return { ...appendKey(table, encoding, keyed), info: { kind: 'text', note: OTHER_NOTE } };
}

/** The caller guarantees `encoding.category` is a real column of `table`. */
function rewriteCategory(
  table: TableData,
  encoding: VizEncoding,
): CategoryRewrite {
  const ci = colIndex(table.columns, encoding.category);
  const type = table.columns[ci].type;
  const cells = table.rows.map((r) => r[ci]);

  if (type === 'number') {
    // lo/hi over the FILTERED cells: the bins describe what is actually plotted.
    let lo: number | null = null;
    let hi: number | null = null;
    for (const c of cells) {
      if (typeof c !== 'number' || !Number.isFinite(c)) continue;
      if (lo === null || c < lo) lo = c;
      if (hi === null || c > hi) hi = c;
    }
    const plan = binPlan(lo, hi, encoding.bins);
    // KEY ON THE INDEX, LABEL AFTERWARDS. Two bins can compact to the same
    // text — over [2023, 2024] the width is 0.1 and bins 0 and 9 both print
    // "2K–2K" — and keying on that string would FUSE two real buckets while
    // the SQL path, which groups on the integer id, kept them apart. Measured
    // as a live differential failure, not a hypothetical.
    // A non-numeric cell keeps today's behaviour: a null key, labelled ''.
    const keyed = cells.map((c) =>
      typeof c === 'number' && Number.isFinite(c)
        ? String(binIndex(c, plan.lo, plan.width, plan.bins))
        : null,
    );
    return {
      ...appendKey(table, encoding, keyed),
      info: { kind: 'number', binned: true },
      relabel: (l) => (l === '' ? '' : binLabel(Number(l), plan.lo, plan.width, plan.bins, plan.hi)),
    };
  }

  if (type === 'date') {
    const parsed = cells.map((c) => parseDateCell(c));
    const grain = isDateGrain(encoding.grain) ? encoding.grain : defaultGrain(parsed);
    const keyed = parsed.map((p) => (p ? dateBucketLabel(dateBucket(p, grain), grain) : null));
    return { ...appendKey(table, encoding, keyed), info: { kind: 'date', grain } };
  }

  return capText(table, encoding, cells);
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

  // (D) PIVOT — the one encoding whose output is a grid. Dispatched before
  // every check below because a pivot has no `category` and no `values` in the
  // chart sense; `pivotData` owns its own guards and its own warnings.
  if (encoding && encoding.pivot) {
    const out = buildPivotGrid(cols, table.rows, encoding.pivot, filters);
    const chart = pivotChartData(out.grid);
    return {
      data: { labels: chart.labels, series: chart.series, pivot: out.grid },
      recommendedShape: 'categorical',
      warnings: out.warnings,
    };
  }

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
  let category: CategoryInfo | undefined;
  if (!hasSplit && allNone) {
    chart = buildRaw(table, encoding); // (C) scatter/raw — one point per row, untouched
  } else {
    // (A) and (B) both group, so both get the category key rewrite. A MAP does
    // not: its regions are matched to rows by NAME (mapRender.geoMatch), and
    // neither an 'Other' bucket nor a bin label is a place — a us_county
    // choropleth has 3,000+ legitimate regions.
    let enc = encoding;
    let relabel: CategoryRewrite['relabel'];
    if (!encoding.geo) {
      const re = rewriteCategory(table, encoding);
      table = re.table;
      enc = re.encoding;
      category = re.info;
      relabel = re.relabel;
    }
    chart = hasSplit ? buildPivot(table, enc, warnings) : buildAggregated(table, enc, warnings);
    // The bucket ids grouped on are turned into axis text here, once the groups
    // exist — never before, or two buckets sharing a label would become one.
    if (relabel) chart = { labels: chart.labels.map(relabel), series: chart.series };
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

  // Classified from the ORIGINAL encoding and columns: a binned number category
  // is still a number category, and a grained date is still a time series.
  const recommendedShape = recommendChartType(cols, encoding).shape;
  return category ? { data, recommendedShape, warnings, category } : { data, recommendedShape, warnings };
}
