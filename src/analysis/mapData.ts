// What a MAP draws, beyond buildVizData's region items. PURE. MAIN PROCESS.
//
//   point      — one item per row at its latitude/longitude columns (detected
//                by name and range when not chosen), sized by the first
//                measure's raw value, coloured by an optional column;
//   us_city / world_city / us_zip — the aggregated items placed through the
//                offline place table, with the misses counted and listed;
//   every map  — carries the category column (what a click selects), the
//                basemap, and a custom boundary set's id and join property.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import type { VizEncoding } from './visuals';
import { matchPlaces } from './places';
import type { PlaceLevel } from './places';

// ponytail: geoCluster.js is a UMD script (the geoMatch pattern)
const geoCluster = require('./geoCluster') as {
  detectLatLon: (cols: { name: string; type: string }[], sample?: (name: string) => unknown[]) => { lat: string; lon: string } | null;
};

export const MAX_POINTS = 100_000;
const DETECT_SAMPLE = 2000;

const PLACE_LEVELS: readonly string[] = ['us_city', 'world_city', 'us_zip'];

function num(c: Cell | undefined): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  if (typeof c === 'string' && c.trim()) {
    const n = Number(c);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface PointItem { lat: number; lng: number; value: number; name: string; color?: string | number }

export function pointItems(
  columns: ParsedColumn[],
  rows: Cell[][],
  encoding: VizEncoding,
  filters: FilterStep[] = [],
): { ok: true; items: PointItem[]; lat: string; lon: string; skipped: number; warnings: string[] } | { ok: false; error: string } {
  const table = filters.length ? applyPipeline({ columns, rows }, filters) : { columns, rows, warnings: [] as string[] };
  const cols = table.columns;
  const at = (name: string | undefined): number => (name ? cols.findIndex((c) => c.name === name) : -1);
  const geo = encoding.geo || { level: 'point' };
  let lat = geo.lat;
  let lon = geo.lon;
  if (at(lat) < 0 || at(lon) < 0) {
    // Judged on the UNFILTERED rows: a narrow filter can leave too few values
    // to tell a coordinate from a stray number.
    const src = (name: string): unknown[] => {
      const i = columns.findIndex((c) => c.name === name);
      return rows.slice(0, DETECT_SAMPLE).map((r) => r[i]);
    };
    const found = geoCluster.detectLatLon(cols, src);
    if (!found) return { ok: false, error: 'No latitude and longitude columns were found — pick them in the map settings.' };
    lat = found.lat;
    lon = found.lon;
  }
  const li = at(lat);
  const gi = at(lon);
  const measure = (encoding.values || [])[0];
  const si = measure && measure.aggregation !== 'count' ? at(measure.column) : -1;
  const ni = at(encoding.category);
  const ci = at(geo.color);
  const items: PointItem[] = [];
  let skipped = 0;
  for (const r of table.rows) {
    const y = num(r[li]);
    const x = num(r[gi]);
    if (y === null || x === null || Math.abs(y) > 90 || Math.abs(x) > 180) { skipped++; continue; }
    if (items.length >= MAX_POINTS) { skipped++; continue; }
    const item: PointItem = { lat: y, lng: x, value: si >= 0 ? (num(r[si]) ?? 0) : 1, name: ni >= 0 && r[ni] != null ? String(r[ni]) : '' };
    if (ci >= 0 && r[ci] != null && r[ci] !== '') item.color = r[ci] as string | number;
    items.push(item);
  }
  const warnings = [...(table.warnings || [])];
  if (items.length >= MAX_POINTS) warnings.push(`Showing the first ${MAX_POINTS.toLocaleString()} points.`);
  return { ok: true, items, lat: lat as string, lon: lon as string, skipped, warnings };
}

/**
 * Finish a map reply: the category column a click selects, the basemap, a
 * custom boundary's id and property, and — for city / ZIP levels — each
 * item's place, with the values the table does not know counted and listed.
 */
// ponytail: `reply` is the visual:data envelope (VizDataReply in ipc/visuals.ts)
export function decorateGeoReply(reply: any, encoding: VizEncoding): any {
  if (!reply || !reply.ok || !reply.data || !reply.data.geo || !encoding.geo) return reply;
  const g = reply.data.geo;
  const geo = encoding.geo;
  // What a click on a region means rides BESIDE geo, not in it: `geo` stays
  // exactly buildVizData's for every level that existed before this, which the
  // differential suites (test-vizRewire) hold it to.
  reply.data.markColumn = encoding.category;
  if (geo.basemap) g.basemap = geo.basemap;
  if (geo.level === 'custom') {
    g.boundaryId = geo.boundaryId;
    g.property = geo.property;
  }
  if (PLACE_LEVELS.includes(geo.level)) {
    const items: any[] = Array.isArray(g.items) ? g.items : [];
    const m = matchPlaces(items.map((i) => i.name), geo.level as PlaceLevel);
    g.items = items.filter((i) => m.points.has(String(i.name))).map((i) => ({ ...i, ...(m.points.get(String(i.name)) as object) }));
    g.unmatched = m.unmatched;
    g.points = true;
  }
  return reply;
}
