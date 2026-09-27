// Pivot grids — PURE, MAIN PROCESS, no Electron / fs / DOM.
//
// A pivot is the one visual whose SHAPE is a table rather than a plot, so it
// needs a second output next to `{labels, series}`: a `PivotGrid` of row
// headers, column headers and cells. Everything else about it is ordinary —
// visual-level filters, the dashboard filter bar, captions and the export
// pipeline all treat it as any other visual, because `vizData.buildVizData`
// still returns the same `{labels, series}` alongside the grid.
//
// THE APP DOES THE MATH, and here that has one sharp consequence: **a subtotal
// is recomputed from the source rows, never summed from the cells above it.**
// Folding cells would be right for `sum`/`count` and silently wrong for `avg`
// (a mean of means) and for `min`/`max` over a partly-null row. So the grid is
// assembled from several GROUPING SETS — one group-by per (row-depth,
// column-depth) pair the grid actually shows — and every figure in it, leaf,
// subtotal, total and grand, is a real aggregate of real rows.
//
// TWO PATHS, ONE FOLD. `buildPivotGrid` is the JS reference: it runs each
// grouping set through `transforms.applyPipeline`, exactly as `vizData` does.
// `engine/pivotResident` runs the same sets off the stored Parquet. Both hand
// their groups to `foldPivotGrid` here, so the only thing that can differ
// between the two paths is the grouping itself — which is what
// `scripts/test-pivotData.ts` asserts, `Object.is`, cell by cell.
//
// WHICH TOTAL IS WHICH (Excel's own wording, so the builder's two checkboxes
// read the way the user expects):
//   totals.rows    → the trailing **Total column**: each row totalled ACROSS
//                    the column groups. One figure per value field.
//   totals.columns → the bottom **Total row**: each column totalled DOWN the
//                    rows. One figure per grid column.
//   totals.grand   → the corner where those two meet.
// Subtotal ROWS per row level are NOT one of these three. They are the
// hierarchy itself — a two-level pivot without them is just a flat list — so
// they are always emitted when there is more than one row dimension.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep, TableData } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import type { VizAggregation } from './visuals';
import { dateBucket, dateBucketLabel, parseDateCell } from './categoryKey';
import type { DateGrain } from './categoryKey';
import { applyPivotCalcs, applyShowAs, calcSets } from './pivotCalc';
import { sanitizeTableCalc } from './tableCalc';
import type { TableCalc } from './tableCalc';

// ── Encoding ─────────────────────────────────────────────────────────────────

/** Excel's "Show values as". `value` (the default) is the figure itself. */
export type PivotShowAs = 'value' | 'pct_row' | 'pct_col' | 'pct_total' | 'rank';

/**
 * A pivot dimension. `grain` applies to a DATE column only and is deliberately
 * coarser than `categoryKey.DATE_GRAINS`: day and week produce hundreds of
 * column groups, and a pivot's columns are read, not scanned.
 */
export interface PivotDim {
  column: string;
  grain?: 'year' | 'quarter' | 'month';
}

export interface PivotValue {
  column: string;
  aggregation: VizAggregation;
  /** A `VizOverrides.numberFormat` id; the renderer formats, main never does. */
  format?: string;
  /** Per-value override of the grid-wide `showAs`. */
  showAs?: PivotShowAs;
  /** The saved Metric this value IS. ADDITIVE — nothing here reads it. */
  metricId?: string;
  /** A table calculation over this value's cells (pivotCalc.ts). Wins over `showAs`. */
  calc?: TableCalc;
}

/** Renderer-side cell painting. Carried here so it is saved with the visual. */
export interface PivotConditional {
  valueIdx: number;
  kind: 'scale' | 'bars' | 'threshold';
  /** `threshold` only — the line above which a cell reads positive. */
  threshold?: number;
}

export interface PivotEncoding {
  rows: PivotDim[];
  columns: PivotDim[];
  values: PivotValue[];
  /**
   * `by` is 'label' (the row headers, per level) or a GRID COLUMN INDEX — which
   * is exactly what a click on a column header yields, and for a pivot with no
   * column dimensions is the value index. Siblings are sorted at every level,
   * so a sort never breaks the hierarchy apart.
   */
  sort?: { by: 'label' | number; dir: 'asc' | 'desc' };
  totals: { rows: boolean; columns: boolean; grand: boolean };
  showAs?: PivotShowAs;
  conditional?: PivotConditional[];
  /** Keep only the top `n` keys of the OUTERMOST row dimension, by value `byValueIdx`. */
  topN?: { n: number; byValueIdx: number };
}

export const PIVOT_MAX_ROWS = 3;
export const PIVOT_MAX_COLS = 2;
export const PIVOT_MAX_VALUES = 4;

/** Beyond these the grid stops being readable and starts being a download. */
export const PIVOT_ROW_CAP = 2000;
export const PIVOT_COL_CAP = 200;

// ── The grid ─────────────────────────────────────────────────────────────────

export type PivotRowKind = 'leaf' | 'subtotal';

export interface PivotGrid {
  /** One per grid row: the path of dimension labels down to that row. */
  rowHeaders: string[][];
  /** One per grid column: the column-group path, plus the value name when the value is ambiguous. */
  colHeaders: string[][];
  /** `cells[row][col]`, after `showAs`. */
  cells: (number | null)[][];
  /** `[row][valueIdx]` — the trailing Total column, or null when not shown. */
  rowTotals: (number | null)[][] | null;
  /** `[col]` — the bottom Total row, or null when not shown. */
  colTotals: (number | null)[] | null;
  /** `[valueIdx]` — the corner, or null when not shown. */
  grand: (number | null)[] | null;
  /** Per grid row: is it a leaf, or the subtotal of the level it sits at. */
  rowKinds: PivotRowKind[];
  /** Display names of the value fields, in encoding order. */
  valueNames: string[];
  /** How many grid columns one column group spans (= `values.length`). */
  valueCount: number;
  /** `showAs` per value field, resolved (grid-wide default applied). */
  showAs: PivotShowAs[];
  /** Number-format id per value field, '' meaning the app default. */
  formats: string[];
  /** Conditional-formatting rules, as saved. */
  conditional: PivotConditional[];
  /**
   * The sort the grid was BUILT with, echoed back so the renderer's header
   * arrow points the way the rows actually run. The renderer must never derive
   * it from the encoding: the encoding is what was ASKED for, and this is what
   * was done.
   */
  sort: { by: 'label' | number; dir: 'asc' | 'desc' } | null;
  /** Distinct leaf row groups and column groups actually shown. */
  rowGroupCount: number;
  colGroupCount: number;
  /** True when a cap above cut the grid — the UI has to say so. */
  truncated: boolean;
  /**
   * Present only when some value carries a table calculation (pivotCalc.ts):
   * the calc per value field, the cells as FIGURES before any calc (so a
   * tooltip can say "24.1% of total · 1.25M"), and what was ignored.
   */
  calcs?: (TableCalc | null)[];
  rawCells?: (number | null)[][];
  calcWarnings?: string[];
}

// ── Sanitisation ─────────────────────────────────────────────────────────────
//
// Untrusted renderer/stored input, whitelisted the same way `sanitizeEncoding`
// whitelists everything else: keep known keys, clamp each enum to its set, drop
// the rest. Never throws. Called from `visuals.sanitizeEncoding`, so a pivot
// read off disk and a pivot posted over IPC go through the identical gate.

const SHOW_AS: ReadonlySet<string> = new Set(['value', 'pct_row', 'pct_col', 'pct_total', 'rank']);
const PIVOT_GRAINS: ReadonlySet<string> = new Set(['year', 'quarter', 'month']);
const COND_KINDS: ReadonlySet<string> = new Set(['scale', 'bars', 'threshold']);
const AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max', 'none']);

function sanitizeDims(raw: unknown, cap: number): PivotDim[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: PivotDim[] = [];
  for (const d of list) {
    if (out.length >= cap) break;
    if (!d || typeof d !== 'object') continue;
    const o = d as Record<string, unknown>;
    const column = typeof o.column === 'string' ? o.column : '';
    if (!column) continue;
    const dim: PivotDim = { column };
    if (typeof o.grain === 'string' && PIVOT_GRAINS.has(o.grain)) dim.grain = o.grain as PivotDim['grain'];
    out.push(dim);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // a metricId reaches a path
function sanitizeValues(raw: unknown): PivotValue[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: PivotValue[] = [];
  for (const v of list) {
    if (out.length >= PIVOT_MAX_VALUES) break;
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const column = typeof o.column === 'string' ? o.column : '';
    if (!column) continue;
    const val: PivotValue = {
      column,
      aggregation: (typeof o.aggregation === 'string' && AGGS.has(o.aggregation)
        ? o.aggregation : 'sum') as VizAggregation,
    };
    if (typeof o.format === 'string' && o.format) val.format = o.format;
    if (typeof o.showAs === 'string' && SHOW_AS.has(o.showAs)) val.showAs = o.showAs as PivotShowAs;
    if (typeof o.metricId === 'string' && UUID_RE.test(o.metricId)) val.metricId = o.metricId;
    const calc = sanitizeTableCalc(o.calc);
    if (calc) val.calc = calc;
    out.push(val);
  }
  return out;
}

/** A whole `encoding.pivot`, or `undefined` when the input names no pivot. */
export function sanitizePivot(raw: unknown): PivotEncoding | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const rows = sanitizeDims(o.rows, PIVOT_MAX_ROWS);
  const columns = sanitizeDims(o.columns, PIVOT_MAX_COLS);
  const values = sanitizeValues(o.values);
  // No dimension and no measure is not a pivot at all — the caller falls back
  // to the ordinary encoding rather than carrying an empty shell around.
  if (rows.length === 0 && values.length === 0) return undefined;

  const t = (o.totals && typeof o.totals === 'object' ? o.totals : {}) as Record<string, unknown>;
  const enc: PivotEncoding = {
    rows,
    columns,
    values,
    totals: { rows: Boolean(t.rows), columns: Boolean(t.columns), grand: Boolean(t.grand) },
  };

  const s = o.sort && typeof o.sort === 'object' ? (o.sort as Record<string, unknown>) : null;
  if (s) {
    const by = s.by === 'label' ? 'label'
      : (typeof s.by === 'number' && Number.isInteger(s.by) && s.by >= 0 ? s.by : null);
    if (by !== null) enc.sort = { by, dir: s.dir === 'desc' ? 'desc' : 'asc' };
  }
  if (typeof o.showAs === 'string' && SHOW_AS.has(o.showAs)) enc.showAs = o.showAs as PivotShowAs;

  if (Array.isArray(o.conditional)) {
    const conds: PivotConditional[] = [];
    for (const c of o.conditional) {
      if (!c || typeof c !== 'object') continue;
      const co = c as Record<string, unknown>;
      if (typeof co.valueIdx !== 'number' || !Number.isInteger(co.valueIdx) || co.valueIdx < 0) continue;
      if (typeof co.kind !== 'string' || !COND_KINDS.has(co.kind)) continue;
      const rule: PivotConditional = { valueIdx: co.valueIdx, kind: co.kind as PivotConditional['kind'] };
      if (typeof co.threshold === 'number' && Number.isFinite(co.threshold)) rule.threshold = co.threshold;
      conds.push(rule);
    }
    if (conds.length) enc.conditional = conds;
  }

  const tn = o.topN && typeof o.topN === 'object' ? (o.topN as Record<string, unknown>) : null;
  if (tn && typeof tn.n === 'number' && Number.isInteger(tn.n) && tn.n > 0) {
    const byValueIdx = typeof tn.byValueIdx === 'number' && Number.isInteger(tn.byValueIdx) && tn.byValueIdx >= 0
      ? tn.byValueIdx : 0;
    enc.topN = { n: tn.n, byValueIdx };
  }
  return enc;
}

// ── Grouping sets ────────────────────────────────────────────────────────────

/** One group-by: the first `rowDims` row dimensions × the first `colDims` column ones. */
export interface PivotSet {
  rowDims: number;
  colDims: number;
}

export interface PivotGroupRow {
  /** `rowDims` row labels followed by `colDims` column labels. */
  keys: (string | number)[];
  /** One per value field, in encoding order. */
  values: (number | null)[];
}

export interface PivotGroups {
  set: PivotSet;
  rows: PivotGroupRow[];
}

/**
 * Every group-by the grid needs, in a stable order.
 *
 * The leaf set is always first — both paths use it to discover the row and
 * column groups, so it is the one that must be run even if a later one fails.
 */
export function pivotSets(enc: PivotEncoding): PivotSet[] {
  const R = enc.rows.length;
  const C = enc.columns.length;
  const out: PivotSet[] = [{ rowDims: R, colDims: C }];
  const add = (rowDims: number, colDims: number): void => {
    if (!out.some((s) => s.rowDims === rowDims && s.colDims === colDims)) out.push({ rowDims, colDims });
  };
  // Subtotal rows: one per level above the leaf, at full column depth.
  for (let k = 1; k < R; k += 1) add(k, C);
  // The trailing Total column needs a figure for EVERY emitted row, subtotals
  // included — so one no-column set per row level.
  if (enc.totals.rows) for (let k = 1; k <= R; k += 1) add(k, 0);
  if (enc.totals.columns) add(0, C);
  if (enc.totals.grand) add(0, 0);
  // Percent-of-total divides by SOURCE totals, whether or not they are shown.
  for (const s of calcSets(enc)) add(s.rowDims, s.colDims);
  return out;
}

// ── The JS reference path ────────────────────────────────────────────────────

function colIndex(columns: ParsedColumn[], name: string): number {
  return columns.findIndex((c) => c && c.name === name);
}

/** `vizData.labelVal` — a key cell as the grid shows it. */
function labelVal(cell: Cell): string {
  if (cell == null) return '';
  return String(cell);
}

function numOrNull(cell: Cell): number | null {
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
}

const KEY_COL = '__ordinate_pivot';

/**
 * A grained DATE dimension becomes an APPENDED key column, never a rewrite of
 * the source: a value field is allowed to aggregate the very column being
 * grouped, and it must still see the original cells. Same discipline, same
 * reason, as `vizData.appendKey`.
 */
function applyGrains(table: TableData, dims: PivotDim[]): { table: TableData; names: string[] } {
  const names = dims.map((d) => d.column);
  let cur = table;
  dims.forEach((d, i) => {
    if (!d.grain) return;
    const ci = colIndex(cur.columns, d.column);
    if (ci < 0) return;
    let name = `${KEY_COL}_${i}`;
    for (let n = 1; cur.columns.some((c) => c && c.name === name); n += 1) name = `${KEY_COL}_${i}_${n}`;
    const columns = cur.columns.concat([{ name, type: 'text' }]);
    const rows = cur.rows.map((r) => {
      const p = parseDateCell(r[ci]);
      return r.concat([p ? dateBucketLabel(dateBucket(p, d.grain as DateGrain), d.grain as DateGrain) : null]);
    });
    cur = { columns, rows };
    names[i] = name;
  });
  return { table: cur, names };
}

function aggFn(v: PivotValue): 'sum' | 'avg' | 'count' | 'min' | 'max' {
  // 'none' has no meaning in a pivot cell — every cell is a group. Coerced to
  // sum exactly as `vizData.buildAggregated` coerces it, and named that way too.
  return (v.aggregation === 'none' ? 'sum' : v.aggregation) as 'sum' | 'avg' | 'count' | 'min' | 'max';
}

/** The legend/header name for a value field — `vizData.measureLabel`'s rule. */
export function pivotValueName(v: PivotValue): string {
  const fn = aggFn(v);
  return fn === 'count' ? v.column : `${fn} of ${v.column}`;
}

/** One grouping set, folded in JS by the same pipeline every other surface uses. */
function runSetJs(
  table: TableData,
  rowNames: string[],
  colNames: string[],
  set: PivotSet,
  values: PivotValue[],
  warnings: string[],
): PivotGroupRow[] {
  const groupBy = rowNames.slice(0, set.rowDims).concat(colNames.slice(0, set.colDims));
  const out = applyPipeline(table, [
    {
      type: 'group_aggregate' as const,
      groupBy,
      aggregations: values.map((v, i) => ({ column: v.column, fn: aggFn(v), as: `m${i}` })),
    },
  ]);
  for (const w of out.warnings) if (!warnings.includes(w)) warnings.push(w);
  const n = groupBy.length;
  return out.rows.map((r) => ({
    keys: r.slice(0, n).map(labelVal),
    values: values.map((_, i) => numOrNull(r[n + i])),
  }));
}

export interface PivotResult {
  grid: PivotGrid;
  warnings: string[];
}

/**
 * The reference implementation: a dataset's columns + rows + a pivot encoding →
 * the grid. PURE and total — a missing column, no dimension or no value field
 * yields an empty grid and a warning, never a throw.
 *
 * `filters` run FIRST, over the raw rows, so every figure below is computed from
 * the filtered subset by the same tested pipeline.
 */
export function buildPivotGrid(
  columns: ParsedColumn[],
  rows: Cell[][],
  enc: PivotEncoding,
  filters?: FilterStep[],
): PivotResult {
  const warnings: string[] = [];
  let table: TableData = {
    columns: Array.isArray(columns) ? columns : [],
    rows: Array.isArray(rows) ? rows : [],
  };
  if (filters && filters.length > 0) {
    const filtered = applyPipeline(table, filters);
    for (const w of filtered.warnings) warnings.push(w);
    table = { columns: filtered.columns, rows: filtered.rows };
  }

  if (!enc || enc.rows.length === 0) {
    warnings.push('A pivot needs at least one row dimension.');
    return { grid: emptyGrid(enc), warnings };
  }
  if (enc.values.length === 0) {
    warnings.push('A pivot needs at least one value field.');
    return { grid: emptyGrid(enc), warnings };
  }

  // Top N narrows the OUTERMOST row dimension to an `in` filter, so every
  // grouping set below — subtotals, totals and the grand alike — is computed
  // over the same narrowed rows. Folding the excluded groups out afterwards
  // would leave totals describing rows the grid does not show.
  const narrowed = enc.topN ? applyTopN(table, enc, warnings) : table;

  const grained = applyGrains(narrowed, enc.rows);
  const colGrained = applyGrains(grained.table, enc.columns);
  const groups = pivotSets(enc).map((set) => ({
    set,
    rows: runSetJs(colGrained.table, grained.names, colGrained.names, set, enc.values, warnings),
  }));
  return { grid: foldPivotGrid(enc, groups), warnings };
}

/**
 * The outermost row dimension's keys, ranked the way `vizData.capText` ranks its
 * long tail: value descending, nulls last, ties broken by first-seen position.
 * One rule for "which groups matter", and `engine/pivotResident` spells the same
 * one as `ORDER BY m0 DESC NULLS LAST, min(<ordinal>)`.
 */
function rankedTopNKeysJs(table: TableData, enc: PivotEncoding, warnings: string[]): string[] {
  const topN = enc.topN as { n: number; byValueIdx: number };
  const dim = enc.rows[0];
  const v = enc.values[Math.min(topN.byValueIdx, enc.values.length - 1)];
  const grained = applyGrains(table, [dim]);
  const ranked = runSetJs(grained.table, grained.names, [], { rowDims: 1, colDims: 0 }, [v], warnings);
  return ranked
    .map((g, i) => ({ key: String(g.keys[0]), v: g.values[0], i }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) {
        if (a.v !== b.v) return a.v === null ? 1 : -1;
      } else if (a.v !== b.v) {
        return b.v - a.v;
      }
      return a.i - b.i;
    })
    .map((r) => r.key);
}

/**
 * Top N as an ORDINARY filter step, which is the whole trick: narrowing the
 * rows before any grouping set runs means the subtotals, the totals and the
 * grand all describe exactly the groups the grid shows. Folding the excluded
 * groups out afterwards would leave totals describing rows nobody can see.
 *
 * `null` means "no narrowing": fewer groups than `n` (nothing to cut), or an
 * outermost dimension rolled up by grain — the bucket label is not a cell
 * value, so an `in` on the source column could not express it. Both paths take
 * this same decision from this same function.
 */
export function pivotTopNFilter(enc: PivotEncoding, rankedKeys: string[]): FilterStep | null {
  const topN = enc.topN;
  if (!topN) return null;
  const dim = enc.rows[0];
  if (!dim || dim.grain) return null;
  if (rankedKeys.length <= topN.n) return null;
  return { type: 'filter', column: dim.column, op: 'in', values: rankedKeys.slice(0, topN.n) };
}

function applyTopN(table: TableData, enc: PivotEncoding, warnings: string[]): TableData {
  const dim = enc.rows[0];
  if (dim && dim.grain) {
    warnings.push('Top N is not applied to a date dimension that is rolled up by grain.');
    return table;
  }
  const step = pivotTopNFilter(enc, rankedTopNKeysJs(table, enc, warnings));
  if (!step) return table;
  const filtered = applyPipeline(table, [step]);
  for (const w of filtered.warnings) warnings.push(w);
  return { columns: filtered.columns, rows: filtered.rows };
}

function emptyGrid(enc: PivotEncoding | null | undefined): PivotGrid {
  const values = enc && Array.isArray(enc.values) ? enc.values : [];
  return {
    rowHeaders: [], colHeaders: [], cells: [],
    rowTotals: null, colTotals: null, grand: null,
    rowKinds: [],
    valueNames: values.map(pivotValueName),
    valueCount: values.length,
    showAs: values.map(() => 'value' as PivotShowAs),
    formats: values.map((v) => v.format || ''),
    conditional: (enc && enc.conditional) || [],
    sort: (enc && enc.sort) || null,
    rowGroupCount: 0, colGroupCount: 0, truncated: false,
  };
}

// ── The fold: grouping sets → a grid ─────────────────────────────────────────

interface Node {
  label: string;
  path: string[];
  children: Node[];
  byLabel: Map<string, Node>;
}

function newNode(label: string, path: string[]): Node {
  return { label, path, children: [], byLabel: new Map() };
}

const joinKey = (parts: (string | number)[]): string => JSON.stringify(parts.map(String));

/**
 * THE SHARED FOLD — the one place a grid is assembled, fed identically by the
 * JS path and the resident one. Pure, total, and deliberately ignorant of where
 * its groups came from.
 */
export function foldPivotGrid(enc: PivotEncoding, groups: PivotGroups[]): PivotGrid {
  const R = enc.rows.length;
  const C = enc.columns.length;
  const V = enc.values.length;
  if (R === 0 || V === 0) return emptyGrid(enc);

  // Index every set by (rowDims, colDims) → key → values.
  const index = new Map<string, Map<string, (number | null)[]>>();
  for (const g of groups) {
    const m = new Map<string, (number | null)[]>();
    for (const row of g.rows) m.set(joinKey(row.keys), row.values);
    index.set(`${g.set.rowDims}:${g.set.colDims}`, m);
  }
  const at = (rowPath: string[], colPath: string[]): (number | null)[] | null => {
    const m = index.get(`${rowPath.length}:${colPath.length}`);
    if (!m) return null;
    return m.get(joinKey(rowPath.concat(colPath))) || null;
  };

  const leaf = groups.find((g) => g.set.rowDims === R && g.set.colDims === C);
  const leafRows = leaf ? leaf.rows : [];

  // ── Column groups, first-seen order, capped ──
  let truncated = false;
  const colPaths: string[][] = [];
  const colSeen = new Set<string>();
  if (C === 0) {
    colPaths.push([]);
  } else {
    for (const g of leafRows) {
      const path = g.keys.slice(R).map(String);
      const k = joinKey(path);
      if (colSeen.has(k)) continue;
      if (colPaths.length >= PIVOT_COL_CAP) { truncated = true; break; }
      colSeen.add(k);
      colPaths.push(path);
    }
  }

  // ── Row groups as a tree, first-seen order, capped on distinct LEAF paths ──
  const root = newNode('', []);
  let rowGroupCount = 0;
  const leafSeen = new Set<string>();
  for (const g of leafRows) {
    const path = g.keys.slice(0, R).map(String);
    const k = joinKey(path);
    if (leafSeen.has(k)) continue;
    if (rowGroupCount >= PIVOT_ROW_CAP) { truncated = true; break; }
    leafSeen.add(k);
    rowGroupCount += 1;
    let node = root;
    for (let d = 0; d < R; d += 1) {
      const label = path[d];
      let next = node.byLabel.get(label);
      if (!next) {
        next = newNode(label, path.slice(0, d + 1));
        node.byLabel.set(label, next);
        node.children.push(next);
      }
      node = next;
    }
  }

  // ── Emit rows: a parent first with its own subtotal, then its children ──
  const gridCols = colPaths.length * V;
  const rowHeaders: string[][] = [];
  const rowKinds: PivotRowKind[] = [];
  const cells: (number | null)[][] = [];
  const rowTotals: (number | null)[][] = [];

  const cellsFor = (path: string[]): (number | null)[] => {
    const out: (number | null)[] = new Array(gridCols).fill(null);
    colPaths.forEach((cp, ci) => {
      const vals = at(path, cp);
      for (let vi = 0; vi < V; vi += 1) out[ci * V + vi] = vals ? (vals[vi] ?? null) : null;
    });
    return out;
  };
  const totalFor = (path: string[]): (number | null)[] => {
    const vals = at(path, []);
    return enc.values.map((_, vi) => (vals ? (vals[vi] ?? null) : null));
  };

  const emit = (node: Node, kind: PivotRowKind, row: (number | null)[]): void => {
    rowHeaders.push(node.path.slice());
    rowKinds.push(kind);
    cells.push(row);
    rowTotals.push(totalFor(node.path));
  };

  // A sort compares siblings by their OWN row, so each node's cells are
  // computed before the ordering and reused by `emit` — one pass, not two.
  const walk = (node: Node, depth: number): void => {
    const kids = node.children;
    const valueOf = new Map<Node, (number | null)[]>();
    for (const k of kids) valueOf.set(k, cellsFor(k.path));
    for (const k of (enc.sort ? sortNodes(kids, valueOf, enc.sort) : kids)) {
      if (depth + 1 === R) {
        emit(k, 'leaf', valueOf.get(k) as (number | null)[]);
      } else {
        emit(k, 'subtotal', valueOf.get(k) as (number | null)[]);
        walk(k, depth + 1);
      }
    }
  };
  walk(root, 0);

  // ── Totals ──
  const colTotals: (number | null)[] = new Array(gridCols).fill(null);
  if (enc.totals.columns) {
    colPaths.forEach((cp, ci) => {
      const vals = at([], cp);
      for (let vi = 0; vi < V; vi += 1) colTotals[ci * V + vi] = vals ? (vals[vi] ?? null) : null;
    });
  }
  const grandVals = enc.totals.grand ? totalFor([]) : null;

  const showAs = enc.values.map((v) => v.showAs || enc.showAs || 'value');
  const grid: PivotGrid = {
    rowHeaders,
    colHeaders: colHeadersFor(colPaths, enc, V, C),
    cells,
    rowTotals: enc.totals.rows ? rowTotals : null,
    colTotals: enc.totals.columns ? colTotals : null,
    grand: grandVals,
    rowKinds,
    valueNames: enc.values.map(pivotValueName),
    valueCount: V,
    showAs,
    formats: enc.values.map((v) => v.format || ''),
    conditional: enc.conditional || [],
    sort: enc.sort || null,
    rowGroupCount,
    colGroupCount: colPaths.length,
    truncated,
  };
  // The calc first: it claims its values (their `showAs` becomes 'value').
  applyPivotCalcs(grid, enc, colPaths, at);
  applyShowAs(grid);
  return grid;
}

/** Sibling ordering, given each node's own (unmodified) cell row. */
function sortNodes(
  nodes: Node[],
  valueOf: Map<Node, (number | null)[]>,
  sort: { by: 'label' | number; dir: 'asc' | 'desc' },
): Node[] {
  const dir = sort.dir === 'desc' ? -1 : 1;
  const decorated = nodes.map((n, i) => ({ n, i }));
  decorated.sort((a, b) => {
    if (sort.by === 'label') {
      if (a.n.label === b.n.label) return a.i - b.i;
      return (a.n.label < b.n.label ? -1 : 1) * dir;
    }
    const av = valueOf.get(a.n)?.[sort.by] ?? null;
    const bv = valueOf.get(b.n)?.[sort.by] ?? null;
    if (av === null || bv === null) {
      if (av !== bv) return av === null ? 1 : -1;
      return a.i - b.i;
    }
    if (av === bv) return a.i - b.i;
    return (av < bv ? -1 : 1) * dir;
  });
  return decorated.map((d) => d.n);
}

function colHeadersFor(colPaths: string[][], enc: PivotEncoding, V: number, C: number): string[][] {
  const names = enc.values.map(pivotValueName);
  const out: string[][] = [];
  for (const cp of colPaths) {
    for (let vi = 0; vi < V; vi += 1) {
      // The value name is only a header level when it disambiguates: one value
      // under real column groups reads better as just the group name.
      out.push(V > 1 || C === 0 ? cp.concat([names[vi]]) : cp.slice());
    }
  }
  return out;
}

// ── The `{labels, series}` every other surface already consumes ──────────────

/**
 * A pivot's LEAF rows as an ordinary chart payload, so captions, the eligibility
 * rules, thumbnails, the dashboard filter bar and the export pipeline need to
 * know nothing about pivots. One grid row becomes one label; one grid column
 * becomes one series.
 */
export function pivotChartData(grid: PivotGrid): {
  labels: (string | number)[];
  series: { name: string; values: (number | null)[]; raw?: (number | null)[]; calc?: TableCalc }[];
} {
  const keep: number[] = [];
  grid.rowKinds.forEach((k, i) => { if (k === 'leaf') keep.push(i); });
  const labels = keep.map((i) => grid.rowHeaders[i].join(' · '));
  const series = grid.colHeaders.map((h, c) => {
    const s = { name: h.join(' · '), values: keep.map((i) => grid.cells[i][c] ?? null) };
    // A calculated value carries its figures too, exactly as a chart series does.
    const calc = grid.calcs && grid.valueCount ? grid.calcs[c % grid.valueCount] : null;
    const raw = grid.rawCells;
    return calc && raw ? { ...s, raw: keep.map((i) => raw[i][c] ?? null), calc } : s;
  });
  return { labels, series };
}
