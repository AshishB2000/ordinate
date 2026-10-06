// The JS REFERENCE for a joined visual, metric and relationship check. PURE —
// no fs, no SQL. `engine/joinResident.ts` is its SQL twin, and
// scripts/test-joins.ts holds the two to `Object.is` agreement.
//
// Three rules, identical on both sides:
//
//  1. KEYS are the stored text of a cell (`String(cell)` — exactly what the
//     Parquet file holds), so `7` and `'7'` match and `'007'` does not. An
//     empty key (null, '' or whitespace; for a number column, anything not a
//     finite number) matches NOTHING — the same as SQL's NULL.
//  2. A hop joins AT MOST ONE row: the first in file order with that key. A
//     many-to-one relationship whose "one" side has duplicates therefore still
//     cannot repeat a primary row; the relationship check reports the duplicates.
//  3. NO FAN-IN. A related row reached by many primary rows is counted ONCE per
//     group for any measure on it: "sum of target by region" is each region's
//     target, not target × orders. Measures on the primary need no mask — the
//     plan (joinPlan.ts) already guarantees its rows never repeat.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep, TableData } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import { computeMetric } from './metricValue';
import type { MetricAggregation } from './metricValue';
import { buildVizData } from './vizData';
import type { VizDataResult } from './vizData';
import type { DsInfo, JoinLayout, JoinPlan, VizJoin } from './joinPlan';

/** The hidden per-table ordinal column. NUL-prefixed, so no header can collide with it. */
export function ordName(t: number): string {
  return `\u0000o${t}`;
}

/** Rule 1: the join key of one stored cell, or null when it can match nothing. */
export function keyOf(cell: Cell | undefined, type: ParsedColumn['type']): string | null {
  if (type === 'number') return typeof cell === 'number' && Number.isFinite(cell) ? String(cell) : null;
  if (cell == null) return null;
  const s = String(cell);
  return s.trim() === '' ? null : s;
}

/**
 * The joined table: the layout's merged columns, then one hidden ordinal per
 * table (the row's index in its own dataset, null when that hop found nothing).
 * Primary row order is preserved, and every primary row appears exactly once.
 */
export function joinTables(
  plan: JoinPlan,
  layout: JoinLayout,
  tables: Map<string, TableData>,
  infos: Map<string, DsInfo>,
): TableData {
  const T = plan.tables.length;
  const width = layout.columns.length;
  const primary = tables.get(plan.tables[0].datasetId) as TableData;
  const rows: Cell[][] = primary.rows.map((r, i) => {
    const out: Cell[] = new Array(width + T).fill(null);
    for (let c = 0; c < primary.columns.length; c++) out[c] = r[c] ?? null;
    out[width] = i;
    return out;
  });

  for (let t = 1; t < T; t++) {
    const via = plan.tables[t].via;
    const data = tables.get(plan.tables[t].datasetId);
    const toInfo = infos.get(plan.tables[t].datasetId);
    if (!via || !data || !toInfo) continue;
    const toCi = toInfo.columns.findIndex((c) => c.name === via.to.column);
    const ft = plan.tables.findIndex((x) => x.datasetId === via.from.datasetId);
    const fromInfo = infos.get(via.from.datasetId) as DsInfo;
    const fromLocal = fromInfo.columns.findIndex((c) => c.name === via.from.column);
    if (toCi < 0 || ft < 0 || fromLocal < 0) continue;
    const fromCi = layout.offsets[ft] + fromLocal;
    const fromType = layout.columns[fromCi].type;

    // Rule 2: the FIRST row per key.
    const index = new Map<string, number>();
    data.rows.forEach((r, i) => {
      const k = keyOf(r[toCi], toInfo.columns[toCi].type);
      if (k !== null && !index.has(k)) index.set(k, i);
    });
    const off = layout.offsets[t];
    for (const row of rows) {
      if (row[width + ft] === null) continue; // the upstream hop found nothing
      const k = keyOf(row[fromCi], fromType);
      const hit = k === null ? undefined : index.get(k);
      if (hit === undefined) continue;
      const src = data.rows[hit];
      for (let c = 0; c < toInfo.columns.length; c++) row[off + c] = src[c] ?? null;
      row[width + t] = hit;
    }
  }
  const columns: ParsedColumn[] = layout.columns.concat(
    plan.tables.map((_, t) => ({ name: ordName(t), type: 'number' as const })),
  );
  return { columns, rows };
}

/** A group key's identity exactly as `group_aggregate` sees it: typed, null distinct from ''. */
function cellId(c: Cell): string {
  return c === null ? '\u0001' : typeof c + ':' + String(c);
}

/**
 * Rule 3: null out a related table's MEASURE cells on every row after the first
 * that shares (group key, that table's row). Only measure columns — the key and
 * the filters have already been read.
 */
export function maskFanIn(table: TableData, keyCols: string[], measureTable: Map<string, number>): TableData {
  const idx = (n: string): number => table.columns.findIndex((c) => c.name === n);
  const keys = keyCols.map(idx).filter((i) => i >= 0);
  const byTable = new Map<number, number[]>();
  for (const [col, t] of measureTable) {
    if (t <= 0) continue;
    const ci = idx(col);
    if (ci < 0) continue;
    byTable.set(t, [...(byTable.get(t) || []), ci]);
  }
  if (byTable.size === 0) return table;
  const rows = table.rows.map((r) => r.slice());
  for (const [t, cols] of byTable) {
    const oi = idx(ordName(t));
    const seen = new Set<string>();
    for (const r of rows) {
      if (r[oi] === null) continue; // unmatched: its measure cells are already null
      const id = keys.map((k) => cellId(r[k])).join('\u0002') + '\u0002' + String(r[oi]);
      if (seen.has(id)) for (const ci of cols) r[ci] = null;
      else seen.add(id);
    }
  }
  return { columns: table.columns, rows };
}

/** The joined visual, JS reference: join, then the ordinary buildVizData with the fan-in mask. */
export function joinedVizDataJs(join: VizJoin, tables: Map<string, TableData>, infos: Map<string, DsInfo>): VizDataResult {
  const joined = joinTables(join.plan, join.layout, tables, infos);
  const out = buildVizData(joined.columns, joined.rows, join.encoding, join.filters, {
    afterKey: (t, keyCols) => maskFanIn(t, keyCols, join.measureTable),
  });
  return out;
}

/**
 * One metric over a join, JS reference. `column` is a MERGED name; a related
 * measure is counted once per related row (a single group).
 */
export function joinedMetricJs(
  plan: JoinPlan,
  layout: JoinLayout,
  tables: Map<string, TableData>,
  infos: Map<string, DsInfo>,
  spec: { column: string; aggregation: MetricAggregation; table: number },
  filters: FilterStep[],
): number | null {
  const joined = joinTables(plan, layout, tables, infos);
  const filtered = filters.length ? applyPipeline(joined, filters) : joined;
  const masked = maskFanIn(filtered, [], new Map([[spec.column, spec.table]]));
  return computeMetric(masked.columns, masked.rows, { column: spec.column, aggregation: spec.aggregation });
}

export interface KeyStats {
  /** FROM rows whose key found a TO row. */
  matched: number;
  /** FROM rows that found none — empty keys included. */
  unmatchedFrom: number;
  /** Distinct non-empty keys on each side, and how many rows carried one. */
  fromKeys: number;
  fromKeyed: number;
  toKeys: number;
  toKeyed: number;
}

/** Full-table relationship check, JS reference (`joinResident.keyStatsResident`). */
export function keyStatsJs(
  fromCells: Cell[],
  fromType: ParsedColumn['type'],
  toCells: Cell[],
  toType: ParsedColumn['type'],
): KeyStats {
  const toSet = new Set<string>();
  let toKeyed = 0;
  for (const c of toCells) {
    const k = keyOf(c, toType);
    if (k !== null) { toSet.add(k); toKeyed++; }
  }
  const fromSet = new Set<string>();
  let fromKeyed = 0;
  let matched = 0;
  for (const c of fromCells) {
    const k = keyOf(c, fromType);
    if (k === null) continue;
    fromSet.add(k);
    fromKeyed++;
    if (toSet.has(k)) matched++;
  }
  return {
    matched,
    unmatchedFrom: fromCells.length - matched,
    fromKeys: fromSet.size,
    fromKeyed,
    toKeys: toSet.size,
    toKeyed,
  };
}

/**
 * The SAMPLED join rate a key suggestion is ranked by: of the first `sample`
 * FROM rows with a key, the share whose key exists anywhere in TO. Null when
 * the sample holds no key at all.
 */
export function joinRateJs(
  fromCells: Cell[],
  fromType: ParsedColumn['type'],
  toCells: Cell[],
  toType: ParsedColumn['type'],
  sample: number,
): number | null {
  const toSet = new Set<string>();
  for (const c of toCells) {
    const k = keyOf(c, toType);
    if (k !== null) toSet.add(k);
  }
  let n = 0;
  let hit = 0;
  for (const c of fromCells.slice(0, sample)) {
    const k = keyOf(c, fromType);
    if (k === null) continue;
    n++;
    if (toSet.has(k)) hit++;
  }
  return n === 0 ? null : hit / n;
}
