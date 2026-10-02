// Small multiples — PURE, MAIN PROCESS, NO MODEL.
//
// A faceted chart is ONE grouped query with the facet dimensions added to the
// GROUP BY, split here into a trellis of panels of the same chart type. Two
// paths produce the grouped rows — `buildFacetData` below (the JS reference,
// over hydrated rows) and `engine/facetResident` (DuckDB over the stored
// Parquet) — and BOTH hand them to the one fold in this file, so the panel
// split, the "Other" fold, the order, the titles and the axis domains cannot
// differ between them. `scripts/test-facetsResident.ts` asserts the two agree.
//
// Three decisions that both paths share, and why:
//   • The CATEGORY key (bins, date grain, top-50 cap) is resolved over ALL the
//     filtered rows, not per panel, so every panel shares one x axis.
//   • A facet dimension keeps its top N−1 values by the first measure and folds
//     the rest into "Other" BEFORE aggregation (an average of averages is not an
//     average). Ranking is by value, ties by first-seen; order is then by label
//     or by that same value.
//   • A facet value is the cell as text; empty (null, '' or whitespace) is its
//     own "(blank)" panel. SQL hands back an INDEX into the kept list, never a
//     label, so a real value spelled "Other" can never merge with the fold.

import type { Cell, FilterStep, TableData } from '../data/transforms';
import { applyPipeline, isEmptyCell } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import type { VizEncoding, VizMeasure } from './visuals';
import type { ChartData, VizDataResult } from './vizData';
import { buildVizData, keyOf, labelVal, measureLabel, numOrNull, recommendChartType, rewriteCategory } from './vizData';
import type { ResolvedOverlay } from './analytics';
import type { PivotGrid } from './pivotData';
import { OTHER_LABEL } from './categoryKey';

export const FACET_MAX_PANELS = 36;
const DEFAULT_MAX = 12;
export const BLANK_LABEL = '(blank)';

export interface FacetEncoding {
  /** One dimension down the side and/or one across the top. One alone wraps. */
  rows?: string;
  cols?: string;
  /** Shared: every panel on one value axis. Independent: each panel its own. */
  scale?: 'shared' | 'independent';
  /** Panel order: by the value's label, or by the first measure (largest first). */
  order?: 'label' | 'measure';
  /** Panels per dimension before the rest fold into "Other" (2–36). */
  max?: number;
  /** Panel title template: `{field}` and `{value}`. Default `{value}`. */
  title?: string;
}

/** A panel's value-axis extent — plain, and stacked (per-label sums of each sign). */
export interface FacetDomain { min: number; max: number; stackMin: number; stackMax: number }

export interface FacetPanel {
  row: number;
  col: number;
  title: string;
  /** The filter steps that select this panel's rows — the drill and cross-filter use them. */
  steps: FilterStep[];
  labels: (string | number)[];
  series: ChartData['series'];
  /** A row × column combination with no rows at all. */
  empty: boolean;
  domain: FacetDomain | null;
  analytics?: ResolvedOverlay[];
  /** A faceted PIVOT: this panel's own grid (ipc/visualsFacets). */
  pivot?: PivotGrid;
}

export interface FacetGrid {
  rowField?: string;
  colField?: string;
  /** Header labels (title template applied), in display order. One dimension → `rows` is empty and the grid wraps. */
  rows: string[];
  cols: string[];
  scale: 'shared' | 'independent';
  domain: FacetDomain | null;
  panels: FacetPanel[];
  /** True when a dimension folded its tail into "Other". */
  folded: boolean;
}

// ── sanitize ────────────────────────────────────────────────────────────────

export function sanitizeFacet(raw: unknown): FacetEncoding | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const f: FacetEncoding = {};
  if (typeof o.rows === 'string' && o.rows) f.rows = o.rows;
  if (typeof o.cols === 'string' && o.cols && o.cols !== f.rows) f.cols = o.cols;
  if (!f.rows && !f.cols) return undefined;
  if (o.scale === 'independent') f.scale = 'independent';
  if (o.order === 'measure') f.order = 'measure';
  const n = typeof o.max === 'number' ? Math.round(o.max) : NaN;
  if (Number.isFinite(n) && n >= 2 && n <= FACET_MAX_PANELS) f.max = n;
  if (typeof o.title === 'string' && o.title.trim() && o.title.length <= 80) f.title = o.title;
  return f;
}

/** Which facet dimensions, each with its panel cap (a 2-D grid stays within 36 panels). */
export function facetDims(f: FacetEncoding): { column: string; cap: number }[] {
  const both = !!(f.rows && f.cols);
  const cap = Math.min(f.max || DEFAULT_MAX, both ? 6 : FACET_MAX_PANELS);
  const out: { column: string; cap: number }[] = [];
  if (f.rows) out.push({ column: f.rows, cap });
  if (f.cols) out.push({ column: f.cols, cap });
  return out;
}

// ── ranking and the "Other" fold (shared by both paths) ─────────────────────

/** One facet dimension, planned: which values keep a panel, in which order. */
export interface FacetDim {
  column: string;
  /** Kept values in RANK order — a row's facet index is its position here, −1 = Other. */
  keep: (string | null)[];
  folded: boolean;
  /** Display order as indexes into `keep`, with −1 (Other) last when folded. */
  order: number[];
}

/** Natural label order; blank last. Fixed 'en' collation so main is deterministic. */
function cmpKey(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * `ranked` is the dimension's values by the first measure, descending, nulls
 * last, ties by first-seen — at least `cap + 1` of them when there are that
 * many (the resident path asks for exactly cap + 1, the JS path passes all).
 */
export function planFacetDim(column: string, ranked: { key: string | null }[], cap: number, order: 'label' | 'measure'): FacetDim {
  const folded = ranked.length > cap;
  const keep = (folded ? ranked.slice(0, cap - 1) : ranked).map((r) => r.key);
  const idx = keep.map((_, i) => i);
  if (order === 'label') idx.sort((a, b) => cmpKey(keep[a], keep[b]));
  if (folded) idx.push(-1);
  return { column, keep, folded, order: idx };
}

/** The JS twin of `ORDER BY m0 DESC NULLS LAST, min(ordinal)` over first-seen groups. */
export function rankGroups(groups: { key: string | null; m: number | null }[]): { key: string | null; m: number | null }[] {
  return groups
    .map((g, i) => ({ ...g, i }))
    .sort((a, b) => {
      if (a.m === null || b.m === null) {
        if (a.m !== b.m) return a.m === null ? 1 : -1;
      } else if (a.m !== b.m) {
        return b.m - a.m;
      }
      return a.i - b.i;
    })
    .map(({ key, m }) => ({ key, m }));
}

/** A cell as a facet key: empty is null, everything else its text. */
export function facetKey(cell: Cell): string | null {
  return isEmptyCell(cell) ? null : String(cell);
}

// ── the fold ────────────────────────────────────────────────────────────────

/** One aggregated group: a (row, col, category[, split]) tuple and its figures. */
export interface FacetGroup {
  r: number; // index into dims[0].keep, −1 = Other; 0 when there is no such dimension
  c: number;
  /** The category's group identity within ONE path (a bucket id, a raw cell) — never compared across paths. */
  key: string;
  label: string | number;
  /** The split value (a split chart only); null and '' stay distinct, as in buildVizData. */
  split?: string | null;
  values: (number | null)[];
}

function valueLabel(dim: FacetDim, i: number): string {
  if (i < 0) return OTHER_LABEL;
  const k = dim.keep[i];
  return k === null ? BLANK_LABEL : k;
}

function valueSteps(dim: FacetDim, i: number): FilterStep[] {
  const column = dim.column;
  if (i >= 0) {
    const k = dim.keep[i];
    return [k === null ? { type: 'filter', column, op: 'is_empty' } : { type: 'filter', column, op: '=', value: k }];
  }
  const named = dim.keep.filter((k): k is string => k !== null);
  const steps: FilterStep[] = [];
  if (named.length) steps.push({ type: 'filter', column, op: 'not in', values: named });
  if (dim.keep.includes(null)) steps.push({ type: 'filter', column, op: 'not_empty' });
  return steps;
}

function title(template: string | undefined, field: string, value: string): string {
  return (template || '{value}').split('{field}').join(field).split('{value}').join(value);
}

/** The value-axis extent of one panel, or null when it has no finite figure. */
export function panelDomain(labels: unknown[], series: { values: (number | null)[] }[]): FacetDomain | null {
  let min = Infinity, max = -Infinity, stackMin = 0, stackMax = 0, seen = false;
  for (let i = 0; i < labels.length; i++) {
    let pos = 0, neg = 0;
    for (const s of series) {
      const v = s.values[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      seen = true;
      if (v < min) min = v;
      if (v > max) max = v;
      if (v >= 0) pos += v; else neg += v;
    }
    if (pos > stackMax) stackMax = pos;
    if (neg < stackMin) stackMin = neg;
  }
  return seen ? { min, max, stackMin, stackMax } : null;
}

/** The union of panel domains — the shared scale. */
export function unionDomain(ds: (FacetDomain | null)[]): FacetDomain | null {
  let out: FacetDomain | null = null;
  for (const d of ds) {
    if (!d) continue;
    out = out
      ? { min: Math.min(out.min, d.min), max: Math.max(out.max, d.max), stackMin: Math.min(out.stackMin, d.stackMin), stackMax: Math.max(out.stackMax, d.stackMax) }
      : { ...d };
  }
  return out;
}

/**
 * Grouped rows → the trellis, plus a flattened `{labels, series}` for every
 * surface that does not know about panels (a table view, copy-as-data, a
 * published snapshot): one series per panel × series, named "West · sum of sales".
 *
 * `names` are the series names when the chart has no split (one per measure).
 * Labels and split values are global and first-seen, so every panel shares one
 * category axis and one colour per series; a missing combination is null.
 */
export function foldFacets(
  groups: FacetGroup[],
  dims: FacetDim[],
  names: string[] | null,
  facet: FacetEncoding,
): { grid: FacetGrid; data: ChartData } {
  const labels: (string | number)[] = [];
  const catAt = new Map<string, number>();
  const splits: (string | null)[] = [];
  const splitAt = new Map<string, number>();
  for (const g of groups) {
    if (!catAt.has(g.key)) { catAt.set(g.key, labels.length); labels.push(g.label); }
    if (!names) {
      const sk = JSON.stringify(g.split ?? null);
      if (!splitAt.has(sk)) { splitAt.set(sk, splits.length); splits.push(g.split ?? null); }
    }
  }
  const seriesNames = names || splits.map((s) => (s === null ? '' : s));

  const cells = new Map<string, (number | null)[][]>();
  for (const g of groups) {
    const pk = `${g.r}|${g.c}`;
    let m = cells.get(pk);
    if (!m) { m = seriesNames.map(() => labels.map(() => null as number | null)); cells.set(pk, m); }
    const ci = catAt.get(g.key)!;
    if (names) g.values.forEach((v, si) => { if (si < m!.length) m![si][ci] = v; });
    else m[splitAt.get(JSON.stringify(g.split ?? null))!][ci] = g.values[0] ?? null;
  }

  const rowDim = dims.length === 2 ? dims[0] : null;
  const colDim = dims.length === 2 ? dims[1] : dims[0];
  const rowOrder = rowDim ? rowDim.order : [0];
  const panels: FacetPanel[] = [];
  rowOrder.forEach((ri, row) => {
    colDim.order.forEach((ci, col) => {
      const r = rowDim ? ri : ci;
      const c = rowDim ? ci : 0;
      const m = cells.get(`${r}|${c}`);
      const series = seriesNames.map((name, si) => ({ name, values: m ? m[si] : labels.map(() => null) }));
      const parts = rowDim
        ? [title(facet.title, rowDim.column, valueLabel(rowDim, ri)), title(facet.title, colDim.column, valueLabel(colDim, ci))]
        : [title(facet.title, colDim.column, valueLabel(colDim, ci))];
      panels.push({
        row: rowDim ? row : 0,
        col,
        title: parts.join(' · '),
        steps: (rowDim ? valueSteps(rowDim, ri) : []).concat(valueSteps(colDim, ci)),
        labels,
        series,
        empty: !m,
        domain: m ? panelDomain(labels, series) : null,
      });
    });
  });

  const scale = facet.scale === 'independent' ? 'independent' : 'shared';
  const grid: FacetGrid = {
    rows: rowDim ? rowDim.order.map((i) => title(facet.title, rowDim.column, valueLabel(rowDim, i))) : [],
    cols: colDim.order.map((i) => title(facet.title, colDim.column, valueLabel(colDim, i))),
    scale,
    domain: unionDomain(panels.map((p) => p.domain)),
    panels,
    folded: dims.some((d) => d.folded),
  };
  if (rowDim) grid.rowField = rowDim.column;
  grid.colField = colDim.column;

  const flat: ChartData['series'] = [];
  for (const p of panels) {
    if (p.empty) continue;
    for (const s of p.series) flat.push({ name: seriesNames.length > 1 || !names ? `${p.title} · ${s.name}` : p.title, values: s.values });
  }
  return { grid, data: { labels, series: flat } };
}

// ── the JS reference ────────────────────────────────────────────────────────

function aggFn(v: VizMeasure): 'sum' | 'avg' | 'count' | 'min' | 'max' {
  return v.aggregation === 'none' ? 'sum' : v.aggregation;
}

/** Append a text column computed per row; returns the new column's name. */
function appendCol(t: TableData, base: string, cells: Cell[]): { table: TableData; name: string } {
  let name = base;
  for (let n = 1; t.columns.some((c) => c.name === name); n++) name = `${base}_${n}`;
  return { table: { columns: t.columns.concat([{ name, type: 'text' }]), rows: t.rows.map((r, i) => r.concat([cells[i]])) }, name };
}

/** Rank one facet column's values by the first measure over `t` (already filtered). */
export function rankFacetJs(t: TableData, column: string, m0: VizMeasure): { key: string | null; m: number | null }[] {
  const ci = t.columns.findIndex((c) => c.name === column);
  const keyed = appendCol(t, '__ordinate_facet', t.rows.map((r) => facetKey(r[ci])));
  const out = applyPipeline(keyed.table, [{
    type: 'group_aggregate', groupBy: [keyed.name], aggregations: [{ column: m0.column, fn: aggFn(m0), as: 'm0' }],
  }]);
  return rankGroups(out.rows.map((r) => ({ key: r[0] == null ? null : String(r[0]), m: numOrNull(r[1]) })));
}

/**
 * The faceted chart over hydrated rows — the reference the resident path is
 * tested against. Anything `buildVizData` would refuse (no category, unknown
 * column, no measure) is answered BY `buildVizData`, warning and all.
 */
export function buildFacetData(columns: ParsedColumn[], rows: Cell[][], encoding: VizEncoding, filters?: FilterStep[]): VizDataResult {
  const facet = encoding && encoding.facet;
  const plain = (): VizDataResult => buildVizData(columns, rows, { ...encoding, facet: undefined }, filters);
  if (!facet) return plain();
  const values = Array.isArray(encoding.values) ? encoding.values : [];
  const has = (n: string | undefined) => !!n && columns.some((c) => c.name === n);
  if (!has(encoding.category) || values.length === 0) return plain();
  const dimsIn = facetDims(facet);
  const missing = dimsIn.filter((d) => !has(d.column));
  if (missing.length) {
    const r = plain();
    return { ...r, warnings: r.warnings.concat(missing.map((d) => `Small multiples skipped: unknown column "${d.column}".`)) };
  }

  const warnings: string[] = [];
  let table: TableData = { columns, rows };
  if (filters && filters.length) {
    const f = applyPipeline(table, filters);
    warnings.push(...f.warnings);
    table = { columns: f.columns, rows: f.rows };
  }
  const order = facet.order === 'measure' ? 'measure' : 'label';
  const dims = dimsIn.map((d) => planFacetDim(d.column, rankFacetJs(table, d.column, values[0]), d.cap, order));

  // Each row's panel index per dimension, as a text key column to group on.
  const idxCols: string[] = [];
  for (const d of dims) {
    const ci = table.columns.findIndex((c) => c.name === d.column);
    const at = new Map(d.keep.map((k, i) => [JSON.stringify(k), i]));
    const a = appendCol(table, '__ordinate_panel', table.rows.map((r) => String(at.get(JSON.stringify(facetKey(r[ci]))) ?? -1)));
    table = a.table;
    idxCols.push(a.name);
  }

  const hasSplit = typeof encoding.series === 'string' && encoding.series.length > 0;
  const recommendedShape = recommendChartType(columns, encoding).shape;
  if (!hasSplit && values.every((v) => v.aggregation === 'none')) {
    return rawFacets(table, encoding, dims, idxCols, facet, warnings, recommendedShape);
  }

  const re = rewriteCategory(table, encoding);
  table = re.table;
  const groupBy = idxCols.concat([re.encoding.category], hasSplit ? [encoding.series as string] : []);
  const measures = hasSplit ? values.slice(0, 1) : values;
  const out = applyPipeline(table, [{
    type: 'group_aggregate', groupBy, aggregations: measures.map((v, i) => ({ column: v.column, fn: aggFn(v), as: `m${i}` })),
  }]);
  warnings.push(...out.warnings);
  const k = idxCols.length;
  const groups: FacetGroup[] = out.rows.map((r) => ({
    r: Number(r[0]),
    c: k === 2 ? Number(r[1]) : 0,
    key: keyOf(r[k]),
    label: re.relabel ? re.relabel(labelVal(r[k])) : labelVal(r[k]),
    split: hasSplit ? (r[k + 1] == null ? null : String(labelVal(r[k + 1]))) : undefined,
    values: measures.map((_, i) => numOrNull(r[k + (hasSplit ? 2 : 1) + i])),
  }));
  const names = hasSplit ? null : values.map((v) => measureLabel({ ...v, aggregation: aggFn(v) }));
  const { grid, data } = foldFacets(groups, dims, names, facet);
  return { data: { ...data, facets: grid }, recommendedShape, warnings, category: re.info };
}

/** A scatter (every measure `none`): each panel is its own rows, one point per row. */
function rawFacets(
  table: TableData, encoding: VizEncoding, dims: FacetDim[], idxCols: string[], facet: FacetEncoding,
  warnings: string[], recommendedShape: string,
): VizDataResult {
  const ix = idxCols.map((n) => table.columns.findIndex((c) => c.name === n));
  const byPanel = new Map<string, Cell[][]>();
  for (const r of table.rows) {
    const pk = `${r[ix[0]]}|${ix.length === 2 ? r[ix[1]] : 0}`;
    const list = byPanel.get(pk) || [];
    list.push(r);
    byPanel.set(pk, list);
  }
  // The fold builds titles, steps and order; its shared labels are then replaced
  // per panel, because a scatter's points are rows, not categories.
  const { grid } = foldFacets([], dims, encoding.values.map((v) => v.column), facet);
  grid.panels.forEach((p) => {
    const rd = dims.length === 2 ? dims[0] : null;
    const cd = dims.length === 2 ? dims[1] : dims[0];
    const r = rd ? rd.order[p.row] : cd.order[p.col];
    const c = rd ? cd.order[p.col] : 0;
    const panelRows = byPanel.get(`${r}|${c}`) || [];
    const chart = buildVizData(table.columns, panelRows, { ...encoding, facet: undefined }).data;
    p.labels = chart.labels;
    p.series = chart.series;
    p.empty = panelRows.length === 0;
    p.domain = panelDomain(p.labels, p.series);
  });
  grid.domain = unionDomain(grid.panels.map((p) => p.domain));
  const all = buildVizData(table.columns, table.rows, { ...encoding, facet: undefined }).data;
  return { data: { labels: all.labels, series: all.series, facets: grid }, recommendedShape, warnings };
}
