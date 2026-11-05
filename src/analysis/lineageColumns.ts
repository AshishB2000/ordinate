// What each consumer reads, on the dataset each column belongs to (semantic layer D19) — MAIN, PURE.
//
// `lineage.ts` links a visual or metric to the datasets its columns come from; this file says WHICH columns, so a
// visual that charts Customers.region hangs off Customers, not off Orders. Names only: a column's name, never a
// filter value, formula or path. The node pass that draws columns and terms is ./lineageNodes.

import type { LineageInput } from './lineage';
import type { VizEncoding } from './visuals';
import { findPath, resolveColumnOwner, reachable } from './joinPlan';
import type { DsInfo } from './joinPlan';
import { compile } from '../formula/formula';
import { compileMetricFormula } from './metricFormula';
import type { MetricFormulaProgram } from './metricFormula';

// ponytail: loose record shapes — each store's own sanitizer already shaped them (as ./lineage does)
type Rec = Record<string, any>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** Every VizEncoding key, classified — `tsc` fails when a key is added without a line here. */
export const ENCODING_FIELDS: Readonly<Record<keyof VizEncoding, 'column' | 'columns' | 'dataset' | 'none'>> = {
  category: 'column', series: 'column', values: 'columns',
  geo: 'columns', pivot: 'columns', cohort: 'columns', eventFunnel: 'columns', drivers: 'columns', facet: 'columns',
  categoryDatasetId: 'dataset', seriesDatasetId: 'dataset',
  categoryVia: 'none', grain: 'none', bins: 'none', overlay: 'none', compare: 'none',
};

/** The datasets' columns, in the shape the join planner resolves names with. */
export function dsInfos(input: LineageInput): Map<string, DsInfo> {
  return new Map(input.datasets.filter((d) => str(d.id)).map((d) => [str(d.id), { id: str(d.id), name: str(d.name), columns: arr(d.columns) }]));
}

type Reads = Map<string, string[]>;

/** A reads map that starts with the primary dataset, so a consumer never loses its edge to it. */
function reads(primary: string): { map: Reads; add: (ds: string, column: unknown) => void } {
  const map: Reads = new Map([[primary, []]]);
  const add = (ds: string, column: unknown): void => {
    const c = str(column);
    if (!c || !ds) return;
    const list = map.get(ds) ?? map.set(ds, []).get(ds)!;
    if (!list.includes(c)) list.push(c);
  };
  return { map, add };
}

/** A filter list's columns, each on its own dataset: a term's pinned `datasetId`, a `via` relationship's far end, else the nearest owner. */
function filterReads(primary: string, filters: unknown, input: LineageInput, add: (ds: string, c: unknown) => void): void {
  const infos = dsInfos(input);
  const rels = input.relationships ?? [];
  for (const f of arr(filters)) {
    if (!f || typeof f !== 'object' || f.type === 'term' || !str(f.column)) continue;
    const via = f.via ? rels.find((r) => r.id === f.via) : undefined;
    const ds = str(f.datasetId) || (via ? via.to.datasetId : '') || resolveColumnOwner(primary, str(f.column), rels, infos) || primary;
    add(ds, f.column);
  }
}

/** The shelves other than category, series and values: pivot, geo, cohort, funnel, drivers, facet. Fixed to the primary's own columns. */
function shelfColumns(e: Rec): string[] {
  const dim = (x: unknown): unknown => (x && typeof x === 'object' ? (x as Rec).column : x);
  const g: Rec = e.geo || {}, p: Rec = e.pivot || {}, c: Rec = e.cohort || {}, fn: Rec = e.eventFunnel || {}, dr: Rec = e.drivers || {}, fa: Rec = e.facet || {};
  return [
    ...arr(p.rows).map(dim), ...arr(p.columns).map(dim), ...arr(p.values).filter((v) => v && !v.metricId).map((v) => v.column),
    g.lat, g.lon, g.lat2, g.lon2, g.from, g.to, g.color, g.property,
    c.entity, c.date, c.value,
    fn.entity, fn.event, fn.time, fn.breakdown,
    dr.metric && !dr.metric.metricId ? dr.metric.column : undefined, ...arr(dr.path).map((s) => s && s.column),
    dr.compare && (dr.compare.mode === 'bucket' || dr.compare.mode === 'latest') ? dr.compare.column : undefined,
    fa.rows, fa.cols,
  ].map(str).filter(Boolean);
}

/** Columns a visual reads, by the dataset each is on (categoryDatasetId, seriesDatasetId, values[].datasetId, a filter's datasetId or owner). The primary is always first. */
export function consumerColumns(v: Rec, input: LineageInput): Map<string, string[]> {
  const primary = str(v.datasetId);
  const e: Rec = v.encoding || {};
  const { map, add } = reads(primary);
  add(str(e.categoryDatasetId) || primary, e.category);
  add(str(e.seriesDatasetId) || primary, e.series);
  for (const m of arr(e.values)) if (m && !m.metricId) add(str(m.datasetId) || primary, m.column);
  for (const c of shelfColumns(e)) add(primary, c);
  filterReads(primary, v.filters, input, add);
  return map;
}

/** A formula metric's compiled program, read against its own dataset's columns and every reachable one's (D17); null when it has none or does not compile. */
export function parsedFormula(m: Rec, input: LineageInput): MetricFormulaProgram | null {
  const def: Rec = m.definition || {};
  if (!def.formula) return null;
  const primary = str(m.datasetId);
  const infos = dsInfos(input);
  const names = [primary, ...reachable(primary, input.relationships ?? []).keys()].flatMap((id) => infos.get(id)?.columns ?? []).map((c) => c.name);
  const parsed = compileMetricFormula(String(def.formula), names);
  return parsed.ok ? parsed.program : null;
}

/** The same for a metric: definition.column or the formula's aggregates, filters, timeColumn, snapshot.column. */
export function metricColumns(m: Rec, input: LineageInput): Map<string, string[]> {
  const primary = str(m.datasetId);
  const def: Rec = m.definition || {};
  const infos = dsInfos(input);
  const rels = input.relationships ?? [];
  const { map, add } = reads(primary);
  const own = (c: string): string => resolveColumnOwner(primary, c, rels, infos) ?? primary;
  const program = parsedFormula(m, input);
  for (const a of program ? program.aggregates : []) {
    // an LOD aggregate (`{FIXED [region] : sum([amount])}`) reads the columns inside its braces
    const lod = a.column[0] === '{' ? compile(a.column) : null;
    for (const c of lod ? (lod.ok ? lod.fn.refs : []) : [a.column]) add(own(c), c);
  }
  if (!def.formula && def.column) {
    add(own(str(def.column)), def.column);
    if (def.snapshot) add(own(str(def.snapshot.column)), def.snapshot.column);
  }
  const time = str(m.timeColumn) || str(def.timeColumn);
  if (time) add(own(time), time);
  filterReads(primary, m.filters, input, add);
  return map;
}

/** Join keys a figure crosses: both ends of every hop findPath takes from the primary to each other dataset it reads. */
export function keyColumns(primary: string, others: string[], input: LineageInput): Map<string, string[]> {
  const rels = input.relationships ?? [];
  const { map, add } = reads(primary);
  map.clear();
  for (const o of others) {
    const p = findPath(primary, o, rels);
    if (!p.ok) continue;
    for (const h of p.value) { add(h.from.datasetId, h.from.column); add(h.to.datasetId, h.to.column); }
  }
  return map;
}
