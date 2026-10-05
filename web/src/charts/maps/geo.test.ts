// DIFFERENTIAL: the map port against the desktop's own code (house style —
// two implementations must agree with Object.is, not with hand-written values).
//
// The desktop's map scripts (map*.js, geo*.js) drew each map kind onto a
// recording fake MapLibre map from REAL server replies (the src/analysis modules
// over the bundled sample and the geo fixture); at the T8.1 cutover, when they
// went, every source FeatureCollection, value-label / cluster marker, camera fit
// and pure-helper answer they produced — and the replies they were given — were
// recorded, per test and in order, into __golden__/geo.json. The port now draws
// the same replies and must match those recordings. The name matcher and the
// point clusterer are still the server's own (src/analysis/geoMatch.ts,
// geoCluster.ts), so those two are compared live, over their whole input ranges.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { goldenSequence, golden } from '../../test-golden';
import { CHART_PALETTE, choroplethColor, flowWidth, isDarkHex } from './colors';
import { drawMap, type MapTheme, type Overlay } from './draw';
import { valueLabelKeys } from './features';
import { buildPeriodGeo, geoBBox, abbrevFor, withCentroids } from './geometry';
import { axisOf, detectLatLon, gridCluster } from './geoCluster';
import { matchGeoItem, normalizeName } from './geoMatch';
import { geoChartTypeFor, geoMapFits, geoNeedsText, isMapChartType, withGeoChartType } from './mapKinds';
import type { MapLibre, MlMap } from './maplibre';
import { mapThumbFills, mapThumbProject } from './thumb';
import type { FeatureCollection, MapData } from './types';

// Vitest serves this file as /@fs/<absolute path>: strip that to reach the repo root on disk.
// (Vite rewrites the two-argument `new URL(rel, import.meta.url)` form, so the path is built by hand.)
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/@fs/, '')), '../../../..');
const at = (p: string) => path.join(ROOT, p);
const require = createRequire(at('web/package.json'));

/** Deep equality with Object.is at the leaves — cross-realm safe (no prototype checks). */
function same(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = same(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
    for (const k of ka) {
      const d = same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${String(a)} vs ${String(b)}`;
}
const agree = (port: unknown, legacy: unknown) => expect(same(port, legacy)).toBeNull();

// ── The recorded desktop side ───────────────────────────────────────────────
const GOLDEN = 'src/charts/maps/__golden__/geo.json';
const seq = goldenSequence(GOLDEN, 'cases');
const G = golden<{ finals: Record<string, Record<string, unknown[]>>; inputs: Record<string, unknown> }>(GOLDEN);
// Recorded under the recorder's describe names ("record: …").
const testKey = () => 'record: ' + expect.getState().currentTestName!;
/** The next thing the desktop answered in this test. */
const desktop = (): unknown => {
  return seq.next(testKey());
};
const eq = (port: unknown) => expect(port).toBe(desktop());
const eqDeep = (port: unknown) => expect(port).toEqual(desktop());
const agreeG = (port: unknown) => agree(port, desktop());
/** A map's sources at this step: the recorded lengths of each source's history, over the test's last snapshot. */
const agreeSources = (port: unknown) => {
  const e = desktop() as { sourcesLens: Record<string, number> };
  const last = G.finals[testKey()]!;
  agree(port, Object.fromEntries(Object.entries(e.sourcesLens).map(([id, n]) => [id, last[id]!.slice(0, n)])));
};

// ── Themes and the MapLibre stand-ins ──────────────────────────────────────
const LIGHT: Record<string, string> = {
  '--accent': '#2563eb', '--surface': '#ffffff', '--surface-3': '#eaecf0', '--border-2': '#d6dae1', '--border': '#e4e7ec', '--text-faint': '#aeb4bf',
};
const DARK: Record<string, string> = { ...LIGHT, '--surface': '#1c1c20', '--surface-3': '#303038', '--accent': '#3b82f6' };
let vars = LIGHT;
class Popup {
  setLngLat() { return this; }
  setHTML() { return this; }
  setDOMContent() { return this; }
  addTo() { return this; }
  remove() {}
}
class Marker {
  el: HTMLElement;
  ll: unknown = null;
  removed = false;
  constructor(o: { element: HTMLElement }) { this.el = o.element; }
  setLngLat(ll: unknown) { this.ll = ll; return this; }
  addTo(map: { __markers: Marker[] }) { map.__markers.push(this); return this; }
  remove() { this.removed = true; }
}
const ml = { Popup, Marker } as unknown as MapLibre;

// ── Real server replies ─────────────────────────────────────────────────────
type Columns = Array<{ name: string; type: string }>;
const fixture = (require(at('scripts/geoFixture.js')) as { geoFixture(): { columns: Columns; rows: unknown[][] } }).geoFixture();
// The name matcher and clusterer the server still runs — the live side of the first two cases.
// any: UMD modules without types on this side
const SG = require(at('src/analysis/geoMatch.js')) as any;
const SC = require(at('src/analysis/geoCluster.js')) as any;
const states = (() => {
  const src = readFileSync(at('assets/geo/us-states.js'), 'utf8');
  return JSON.parse(src.replace(/^[\s\S]*?=\s*/, '').replace(/;\s*$/, '')) as FeatureCollection;
})();
const input = <T,>(k: string): T => {
  if (!(k in G.inputs)) throw new Error('no recorded reply for ' + k);
  return structuredClone(G.inputs[k]) as T;
};
const viz = (encoding: object): MapData => input('viz ' + JSON.stringify(encoding));
const byState = (measure: string, series?: string) => viz({ category: 'state', ...(series ? { series } : {}), values: [{ column: measure, aggregation: 'sum' }], geo: { level: 'us_state' } });
const hexData = (): MapData => input('hex');
const flowData = (): MapData => input('flow');
const pointData = (): MapData => input('point');

// ── A recording fake MapLibre map ───────────────────────────────────────────
function fakeMap(zoom = 3) {
  const sources: Record<string, unknown[]> = {};
  const camera: unknown[] = [];
  const handlers: Record<string, Array<() => void>> = {};
  const markers: Marker[] = [];
  const map = {
    __markers: markers,
    zoom,
    addSource: (id: string, spec: { data: unknown }) => void (sources[id] = [JSON.parse(JSON.stringify(spec.data))]),
    getSource: (id: string) => (sources[id] ? { setData: (d: unknown) => sources[id].push(JSON.parse(JSON.stringify(d))) } : undefined),
    addLayer: () => {},
    on: (ev: string, a: unknown, b?: unknown) => void (typeof a === 'function' ? (handlers[ev] ??= []).push(a as () => void) : b),
    once: () => {},
    getZoom: () => map.zoom,
    fitBounds: (b: unknown, o: { padding: number; maxZoom: number }) => void camera.push(['fit', b, o.padding, o.maxZoom]),
    jumpTo: (o: unknown) => void camera.push(['jump', o]),
    easeTo: () => {},
    getCanvas: () => ({ style: {} }),
  };
  const live = () => markers.filter((m) => !m.removed).map((m) => [m.ll, m.el.textContent, m.el.className]);
  const zoomTo = (z: number) => {
    map.zoom = z;
    (handlers.zoomend || []).forEach((h) => h());
  };
  return { map, sources, camera, live, zoomTo };
}
const theme = (v: Record<string, string>): MapTheme => ({
  accent: v['--accent'], surface: v['--surface'], noData: v['--surface-3'], noDataBorder: v['--border-2'], border: v['--border'],
  muted: v['--text-faint'], palette: CHART_PALETTE, dark: isDarkHex(v['--surface']),
});
function port(data: MapData, type: string, features: FeatureCollection | null, zoom = 3) {
  const f = fakeMap(zoom);
  const patches: Array<Partial<Overlay>> = []; // what MapView would merge into the overlay later (zoom, mode, period)
  const drawn = drawMap({ ml, map: f.map as unknown as MlMap, data, type, features: features ? features.features : null, theme: theme(vars), emit: (p) => void patches.push(p) });
  return { ...f, drawn, overlay: () => Object.assign({}, drawn.overlay, ...patches) as Overlay };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Pure helpers ────────────────────────────────────────────────────────────
describe('pure helpers equal the desktop', () => {
  it('normalizeName and matchGeoItem over every state shape', () => {
    const names = ['Roanoke City', 'St. Louis County', 'Prince of Wales-Hyder Census Area', 'United States of America', '  New   York (state) ', '', 'James City'];
    for (const n of names) expect(normalizeName(n)).toBe(SG.normalizeName(n));
    const items = byState('profit').geo!.items;
    for (const f of states.features) agree(matchGeoItem(items, f.properties), SG.matchGeoItem(items, f.properties));
    // Counties (state + county-vs-city kind disambiguate) and countries (iso2, long official names).
    const counties = JSON.parse(readFileSync(at('assets/geo/us-counties.json'), 'utf8')) as FeatureCollection;
    const cItems = counties.features.filter((_, i) => i % 9 === 0).map((f, i) => ({ name: `${String(f.properties.name)}${i % 3 ? ' County' : ''}`, state: String(f.properties.state), kind: i % 4 ? undefined : String(f.properties.kind), value: i }));
    for (const f of counties.features) agree(matchGeoItem(cItems, f.properties), SG.matchGeoItem(cItems, f.properties));
    const world = JSON.parse(readFileSync(at('assets/geo/world-countries.js'), 'utf8').replace(/^[\s\S]*?=\s*/, '').replace(/;\s*$/, '')) as FeatureCollection;
    const wItems = ['United States of America', 'Russian Federation', 'UK', 'de', 'Congo', 'Korea', 'Niger', 'Guinea', 'Sudan'].map((name, value) => ({ name, value }));
    for (const f of world.features) agree(matchGeoItem(wItems, f.properties), SG.matchGeoItem(wItems, f.properties));
    for (const f of counties.features.slice(0, 400)) expect(normalizeName(String(f.properties.name) + ' Parish')).toBe(SG.normalizeName(String(f.properties.name) + ' Parish'));
    // Pinned divergence from the truth, kept for parity: "virginia" ⊂ "west virginia".
    expect(matchGeoItem(items, { name: 'West Virginia' })?.name).toBe('Virginia');
  });

  it('geoCluster: axis detection and grid clusters at every zoom', () => {
    for (const n of ['lat', 'Latitude', 'pickup_lat', 'lngDeg', 'LONGITUDE', 'long', 'wh_lon', 'flat']) expect(axisOf(n)).toBe(SC.axisOf(n));
    const sampler = (name: string) => fixture.rows.map((r) => r[fixture.columns.findIndex((c) => c.name === name)]);
    const lc = SC as { detectLatLon: typeof detectLatLon; gridCluster: typeof gridCluster };
    agree(detectLatLon(fixture.columns, sampler), lc.detectLatLon(fixture.columns, sampler));
    const pts = pointData().geo!.items as Array<{ lat: number; lng: number; value: number }>;
    for (let z = 0; z <= 12; z++) agree(gridCluster(pts, z), lc.gridCluster(pts, z));
    agree(gridCluster(pts.slice(0, 500), 4), lc.gridCluster(pts.slice(0, 500), 4)); // below the threshold: no clustering
  });

  it('mapKinds, in the desktop English', () => {
    const geos = [null, byState('profit').geo, hexData().geo, flowData().geo];
    for (const type of ['map_bubble', 'map_choropleth', 'map_hexbin', 'map_flow', 'column']) {
      eq(isMapChartType(type));
      for (const has of [true, false]) eq(geoNeedsText(type, has));
      for (const g of geos) eq(geoMapFits(type, g));
    }
    for (const g of geos) {
      eq(geoChartTypeFor(g));
      agreeG(withGeoChartType(['column', 'bar'], g));
    }
  });

  it('the colour ramp, both themes, and the flow width scale', () => {
    for (const v of [LIGHT, DARK]) {
      vars = v;
      for (let i = -5; i <= 105; i++) eq(choroplethColor(i / 100, isDarkHex(v['--surface'])));
    }
    vars = LIGHT;
    for (const v of [null, -1, 0, 0.5, 3, 18.8e3, 1e9]) for (const max of [0, 1, 18.8e3]) eq(flowWidth(v, max));
  });

  it('bboxes, abbreviations, centroids and per-period values', () => {
    const items = byState('profit').geo!.items;
    for (const f of states.features) {
      agreeG(geoBBox(f.geometry));
      for (const level of ['us_state', 'country', 'us_county']) eq(abbrevFor({ name: String(f.properties.name) }, f.properties, level));
    }
    agreeG(withCentroids(items, states.features));
    expect(items.every((i) => i.lat === undefined)).toBe(true); // the reply is never mutated
    const ts = byState('profit', 'category');
    expect(ts.dataShape).toBe('time_series');
    const p = buildPeriodGeo(ts.labels, ts.series, ts.geo!.items);
    agreeG([p.periods, p.minVal, p.maxVal]);
    for (let i = 0; i < p.periods.length; i++) agreeG(p.itemsForPeriod(i));
  });

  it('value-label picks and thumbnail projection / fills', () => {
    const rows = [[3, null, 9, -1, 9], [], ['x', 2]];
    for (const mode of ['off', 'all', 'maxmin', 'max', 'min', '']) agreeG([...valueLabelKeys(mode, rows)]);
    const proj = mapThumbProject([-125, 24, -66, 50], 160, 96, 2);
    for (const [x, y] of [[-125, 24], [-95, 39], [-66, 50]]) agreeG(proj(x, y));
    const items = byState('profit').geo!.items;
    agreeG(mapThumbFills(states.features, items, '', (k) => `c${k}`));
  });
});

// ── Every kind, drawn by both ───────────────────────────────────────────────
describe('every map kind draws the same marks as the desktop', () => {
  for (const v of [LIGHT, DARK]) {
    const name = v === LIGHT ? 'light' : 'dark';

    it(`region map (${name}): fills, Max & min labels, camera — then Values → All`, () => {
      vars = v;
      const data = byState('profit');
      const b = port(data, 'map_choropleth', states);
      agreeSources(b.sources);
      agreeG(b.live());
      agreeG(b.camera);
      eq(b.drawn.overlay.stats.matched);
      b.drawn.setValueMode!('all');
      agreeG(b.live());
      vars = LIGHT;
    });
  }

  it('region map stepping through periods (a time-series reply)', () => {
    const data = byState('profit', 'category');
    const b = port(data, 'map_choropleth', states);
    for (const idx of [0, 1, 2]) {
      b.drawn.setPeriod!(idx);
      agreeSources(b.sources);
      agreeG(b.live());
    }
  });

  it('bubble map at region centroids', () => {
    const data = byState('revenue');
    const b = port(data, 'map_bubble', states);
    agreeSources(b.sources);
    agreeG(b.live());
    agreeG(b.camera);
  });

  it('point map: clusters and singles, re-clustered on zoom', () => {
    const data = pointData();
    const b = port(data, 'map_bubble', null);
    for (const z of [3, 6, 9, 14]) {
      b.zoomTo(z);
      agreeSources(b.sources);
      agreeG(b.live());
    }
    agreeG(b.camera);
    eqDeep(b.drawn.overlay.colorLegend?.rows);
  });

  it('hexbin map: the level for each zoom', async () => {
    const data = hexData();
    const b = port(data, 'map_hexbin', null);
    agreeSources(b.sources);
    for (const z of [1, 5, 8, 12]) {
      b.zoomTo(z);
      await sleep(150); // the level swap is debounced by 120 ms (as the desktop's was)
      agreeSources(b.sources);
      eq(b.overlay().notes?.info);
    }
    agreeG(b.camera);
  });

  it('flow map: routes heaviest-last and their ends', () => {
    const data = flowData();
    const b = port(data, 'map_flow', null);
    agreeSources(b.sources);
    agreeG(b.camera);
    eq(b.drawn.overlay.notes?.info);
  });
});

describe('the golden comparison', () => {
  it('every recorded desktop answer was compared', () => {
    expect(seq.rest()).toEqual([]);
  });
});
