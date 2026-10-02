// Hexbin density and origin → destination flows: the JS REFERENCE aggregations
// and the ONE shaping step both engines share. PURE, main process.
//
// Each engine produces GROUPS — per hexagon (res, q, r) or per coordinate pair
// — with three running figures: n (points), c (points with a numeric measure)
// and s (their sum). The resident path (`src/engine/geoResident.ts`) groups in
// DuckDB over the stored Parquet; `hexGroupsJs` / `flowGroupsJs` below group
// the hydrated rows. Everything after that — which levels fit, the value each
// group shows, the sort, the cap, the geometry — is `shapeHexbin` /
// `shapeFlows`, called by both, so the two can only disagree about the groups,
// and scripts/test-geoAgg.ts holds them equal with Object.is.
//
// THE MEASURE. `count` is the number of POINTS (rows with usable coordinates)
// in the hexagon or on the route, whatever the measure column; `sum` and `avg`
// read a DECLARED number column, empty and non-finite cells skipped; a group
// whose measure cells are all empty shows null ("no data"), never 0.
//
// ORDER is never taken from an engine: hexagons sort by (q, r); flows by value
// descending (nulls last), ties by the first stored row on the route.

import type { ParsedColumn } from '../../data/parse';
import type { Cell, FilterStep, TableData } from '../../data/transforms';
import { applyPipeline } from '../../data/transforms';
import type { VizEncoding } from '../visuals';
import { finiteNum, mercX, mercY, onGlobe, onMercator, round6 } from './mercator';
import { HEX_LEVELS, MAX_HEXES, hexCenter, hexId, hexOfWorld, hexRing, hexZoom } from './hexgrid';
import { flowArc } from './flowArc';

export type GeoAgg = 'count' | 'sum' | 'avg';

export interface GeoMeasure {
  agg: GeoAgg;
  /** The measure column for sum/avg; '' for a count of points. */
  column: string;
  /** "Points", "Sum of amount", "Average amount". */
  label: string;
}

export interface HexSpec { lat: string; lng: string; measure: GeoMeasure }
export interface FlowSpec extends HexSpec { lat2: string; lng2: string; from: string; to: string }

/** At most this many routes are drawn: the top N by the measure. */
export const FLOW_CAP = 500;

// ── Specs ────────────────────────────────────────────────────────────────────

/** The measure an encoding asks for; min/max/none fall back to a sum, and say so. */
export function geoMeasure(enc: VizEncoding): { measure: GeoMeasure; warning?: string } {
  const v = Array.isArray(enc.values) ? enc.values[0] : undefined;
  if (!v || !v.column || v.aggregation === 'count') return { measure: { agg: 'count', column: '', label: 'Points' } };
  if (v.aggregation === 'avg') return { measure: { agg: 'avg', column: v.column, label: `Average ${v.column}` } };
  const measure: GeoMeasure = { agg: 'sum', column: v.column, label: `Sum of ${v.column}` };
  if (v.aggregation === 'min' || v.aggregation === 'max') {
    return { measure, warning: 'Hexbin and flow maps show a count, a sum or an average — showing the sum.' };
  }
  return { measure };
}

/** Why the columns cannot be used, or null. Coordinates and a summed measure must be DECLARED numbers. */
export function specProblem(cols: ParsedColumn[], spec: HexSpec | FlowSpec): string | null {
  const need: Array<[string, string]> = [['latitude', spec.lat], ['longitude', spec.lng]];
  if ('lat2' in spec) need.push(['destination latitude', spec.lat2], ['destination longitude', spec.lng2]);
  if (spec.measure.column) need.push(['measure', spec.measure.column]);
  for (const [what, name] of need) {
    if (!name) return `Pick a ${what} column.`;
    const c = cols.find((x) => x && x.name === name);
    if (!c) return `Unknown column "${name}".`;
    if (c.type !== 'number') return `"${name}" is not a number column, so it cannot be the ${what}.`;
  }
  for (const name of 'from' in spec ? [spec.from, spec.to] : []) {
    if (name && !cols.some((x) => x && x.name === name)) return `Unknown column "${name}".`;
  }
  return null;
}

// ── Groups ───────────────────────────────────────────────────────────────────

export interface HexGroup { res: number; q: number; r: number; n: number; c: number; s: number | null }
export interface FlowGroup {
  oa: number; oo: number; da: number; dd: number;
  n: number; c: number; s: number | null;
  /** The first stored row on the route — the tie-break. */
  first: number;
  from: string; to: string;
}
export interface Groups<G> { groups: G[]; points: number; skipped: number; warnings: string[] }
export interface HexGroups extends Groups<HexGroup> {
  /** Distinct hexagons per level, index = resolution. `groups` holds only the levels within MAX_HEXES. */
  levelCounts: number[];
}
export interface FlowGroups extends Groups<FlowGroup> {
  /** Distinct routes before the cap. `groups` may hold only the top FLOW_CAP. */
  routes: number;
}

function filtered(columns: ParsedColumn[], rows: Cell[][], filters: FilterStep[]): TableData & { warnings: string[] } {
  if (!filters.length) return { columns, rows, warnings: [] };
  const out = applyPipeline({ columns, rows }, filters);
  return { columns: out.columns, rows: out.rows, warnings: out.warnings };
}

const at = (cols: ParsedColumn[], name: string): number => (name ? cols.findIndex((c) => c && c.name === name) : -1);
const label = (c: Cell | undefined): string => (c == null ? '' : String(c));

export function hexGroupsJs(columns: ParsedColumn[], rows: Cell[][], spec: HexSpec, filters: FilterStep[]): HexGroups {
  const t = filtered(columns, rows, filters);
  const li = at(t.columns, spec.lat);
  const gi = at(t.columns, spec.lng);
  const mi = at(t.columns, spec.measure.column);
  const maps: Map<string, HexGroup>[] = Array.from({ length: HEX_LEVELS }, () => new Map());
  let points = 0;
  let skipped = 0;
  for (const row of t.rows) {
    const la = finiteNum(row[li]);
    const lo = finiteNum(row[gi]);
    if (!onMercator(la, lo)) { skipped += 1; continue; }
    points += 1;
    const x = mercX(lo as number);
    const y = mercY(la as number);
    const v = mi >= 0 ? finiteNum(row[mi]) : null;
    for (let res = 0; res < HEX_LEVELS; res += 1) {
      const h = hexOfWorld(x, y, res);
      const key = `${h.q}:${h.r}`;
      let g = maps[res].get(key);
      if (!g) { g = { res, q: h.q, r: h.r, n: 0, c: 0, s: 0 }; maps[res].set(key, g); }
      g.n += 1;
      if (v !== null) { g.c += 1; g.s = (g.s as number) + v; }
    }
  }
  const levelCounts = maps.map((m) => m.size);
  const groups = maps.flatMap((m, res) => (levelCounts[res] <= MAX_HEXES ? [...m.values()] : []));
  return { groups, levelCounts, points, skipped, warnings: t.warnings };
}

export function flowGroupsJs(columns: ParsedColumn[], rows: Cell[][], spec: FlowSpec, filters: FilterStep[]): FlowGroups {
  const t = filtered(columns, rows, filters);
  const idx = [spec.lat, spec.lng, spec.lat2, spec.lng2].map((n) => at(t.columns, n));
  const mi = at(t.columns, spec.measure.column);
  const fi = at(t.columns, spec.from);
  const ti = at(t.columns, spec.to);
  const map = new Map<string, FlowGroup>();
  let points = 0;
  let skipped = 0;
  t.rows.forEach((row, i) => {
    const [oa, oo, da, dd] = idx.map((k) => finiteNum(row[k]));
    if (!onGlobe(oa, oo) || !onGlobe(da, dd)) { skipped += 1; return; }
    points += 1;
    const o = [oa as number, oo as number, da as number, dd as number].map((v) => v + 0);
    const key = o.join('|');
    let g = map.get(key);
    if (!g) {
      g = { oa: o[0], oo: o[1], da: o[2], dd: o[3], n: 0, c: 0, s: 0, first: i,
        from: fi >= 0 ? label(row[fi]) : '', to: ti >= 0 ? label(row[ti]) : '' };
      map.set(key, g);
    }
    g.n += 1;
    const v = mi >= 0 ? finiteNum(row[mi]) : null;
    if (v !== null) { g.c += 1; g.s = (g.s as number) + v; }
  });
  return { groups: [...map.values()], routes: map.size, points, skipped, warnings: t.warnings };
}

// ── Shaping (both engines) ───────────────────────────────────────────────────

export function groupValue(agg: GeoAgg, n: number, c: number, s: number | null): number | null {
  if (agg === 'count') return n;
  if (c === 0 || s === null) return null;
  return agg === 'sum' ? s : s / c;
}

export interface HexCell { id: string; q: number; r: number; n: number; value: number | null; lat: number; lng: number; ring: number[] }
export interface HexLevel { res: number; zoom: number; hexes: HexCell[] }
export interface HexbinGeo {
  level: 'hexbin';
  items: Array<{ name: string; value: number; lat: number; lng: number }>;
  hex: {
    agg: GeoAgg; label: string; points: number; skipped: number; maxHexes: number;
    levels: HexLevel[];
    /** Levels left out for having more than maxHexes hexagons. */
    dropped: Array<{ res: number; count: number }>;
  };
}

const coord = (v: number): string => (Math.round(v * 100) / 100).toFixed(2);

export function shapeHexbin(g: HexGroups, measure: GeoMeasure): HexbinGeo {
  const levels: HexLevel[] = [];
  const dropped: Array<{ res: number; count: number }> = [];
  for (let res = 0; res < HEX_LEVELS; res += 1) {
    const count = g.levelCounts[res] || 0;
    if (count > MAX_HEXES) { dropped.push({ res, count }); continue; }
    const hexes = g.groups
      .filter((h) => h.res === res)
      .sort((a, b) => a.q - b.q || a.r - b.r)
      .map((h) => {
        const c = hexCenter(res, h.q, h.r);
        return { id: hexId(res, h.q, h.r), q: h.q, r: h.r, n: h.n, value: groupValue(measure.agg, h.n, h.c, h.s),
          lat: c.lat, lng: c.lng, ring: hexRing(res, h.q, h.r) };
      });
    levels.push({ res, zoom: hexZoom(res), hexes });
  }
  // Captions, thumbnails and the published page read `items`: the finest level
  // that is still a readable summary (≤ 400 hexagons), else the coarsest.
  const summary = [...levels].reverse().find((l) => l.hexes.length <= 400) || levels[0];
  const items = (summary ? summary.hexes : [])
    .filter((h) => typeof h.value === 'number')
    .map((h) => ({ name: `near ${coord(h.lat)}, ${coord(h.lng)}`, value: h.value as number, lat: h.lat, lng: h.lng }));
  return {
    level: 'hexbin',
    items,
    hex: { agg: measure.agg, label: measure.label, points: g.points, skipped: g.skipped, maxHexes: MAX_HEXES, levels, dropped },
  };
}

export interface FlowRoute {
  name: string; from: string; to: string; value: number | null; n: number;
  o: [number, number]; d: [number, number];
  /** The arc to draw, flat [lng, lat, …] — see ./flowArc. */
  path: number[];
}
export interface FlowGeo {
  level: 'flow';
  items: Array<{ name: string; value: number; lat: number; lng: number }>;
  flow: { agg: GeoAgg; label: string; points: number; skipped: number; routes: number; cap: number; flows: FlowRoute[] };
}

/** Value descending, nulls last; ties by the first stored row. */
export function flowOrder(agg: GeoAgg): (a: FlowGroup, b: FlowGroup) => number {
  return (a, b) => {
    const va = groupValue(agg, a.n, a.c, a.s);
    const vb = groupValue(agg, b.n, b.c, b.s);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else if (va !== vb) {
      return vb - va;
    }
    return a.first - b.first;
  };
}

export function shapeFlows(g: FlowGroups, measure: GeoMeasure): FlowGeo {
  const top = g.groups.slice().sort(flowOrder(measure.agg)).slice(0, FLOW_CAP);
  const place = (lat: number, lng: number, name: string): string => name || `${coord(lat)}, ${coord(lng)}`;
  const flows: FlowRoute[] = top.map((f) => {
    const from = place(f.oa, f.oo, f.from);
    const to = place(f.da, f.dd, f.to);
    return {
      name: `${from} → ${to}`, from, to, value: groupValue(measure.agg, f.n, f.c, f.s), n: f.n,
      o: [round6(f.oo), round6(f.oa)], d: [round6(f.dd), round6(f.da)], path: flowArc(f.oa, f.oo, f.da, f.dd),
    };
  });
  const items = flows
    .filter((f) => typeof f.value === 'number')
    .map((f) => ({ name: f.name, value: f.value as number, lat: f.o[1], lng: f.o[0] }));
  return {
    level: 'flow',
    items,
    flow: { agg: measure.agg, label: measure.label, points: g.points, skipped: g.skipped, routes: g.routes, cap: FLOW_CAP, flows },
  };
}
