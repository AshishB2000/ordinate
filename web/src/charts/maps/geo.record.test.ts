// ONE-OFF RECORDER (T8.1) for geo.test.ts: that test, run against the desktop's
// map scripts (map*.js, geo*.js, chartValueLabels.js), with every comparison's
// desktop side recorded per test, in order, into __golden__/geo.json. Runs only
// with GOLDEN_RECORD=1; deleted with the desktop tree in the next commit.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encode } from '../../../../src/server/wire.ts';
import { formatCompact } from '../../../../src/app/format.ts';
import { CHART_PALETTE, choroplethColor, flowWidth, isDarkHex } from './colors';
import { drawMap, type MapTheme, type Overlay } from './draw';
import { valueLabelKeys } from './features';
import { buildPeriodGeo, geoBBox, abbrevFor, withCentroids } from './geometry';
import { axisOf, detectLatLon, gridCluster } from './geoCluster';
import { matchGeoItem, normalizeName } from './geoMatch';
import { geoChartTypeFor, geoMapFits, geoNeedsText, isMapChartType, withGeoChartType } from './mapKinds';
import type { MapLibre, MlMap } from './maplibre';
import { mapThumbFills, mapThumbProject } from './thumb';
import type { FeatureCollection, MapData, MapGeo } from './types';

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
const REC: Record<string, unknown[]> = {};
const rec = (legacy: unknown): unknown => {
  (REC[expect.getState().currentTestName!] ??= []).push(structuredClone(legacy));
  return legacy;
};
const agree = (port: unknown, legacy: unknown) => expect(same(port, rec(legacy))).toBeNull();
const eq = (port: unknown, legacy: unknown) => expect(port).toBe(rec(legacy));
const eqDeep = (port: unknown, legacy: unknown) => expect(port).toEqual(rec(legacy));
// A map's sources only ever GROW (addSource, then setData pushes), so each
// snapshot is a prefix of the test's last one: store the last one once and,
// per comparison, the length of each source's history — checked here.
const SNAP: Record<string, Array<Record<string, unknown[]>>> = {};
const agreeSources = (port: unknown, legacy: Record<string, unknown[]>) => {
  const k = expect.getState().currentTestName!;
  (SNAP[k] ??= []).push(JSON.parse(JSON.stringify(legacy)));
  rec({ sourcesSnapshot: SNAP[k]!.length - 1 });
  expect(same(port, legacy)).toBeNull();
};
afterAll(() => {
  if (!process.env.GOLDEN_RECORD) return;
  const finals: Record<string, Record<string, unknown[]>> = {};
  for (const [k, list] of Object.entries(REC)) {
    const snaps = SNAP[k];
    if (!snaps) continue;
    const last = snaps[snaps.length - 1]!;
    finals[k] = last;
    list.forEach((e, i) => {
      const at = (e as { sourcesSnapshot?: number } | null)?.sourcesSnapshot;
      if (at === undefined) return;
      const snap = snaps[at]!;
      const lens = Object.fromEntries(Object.entries(snap).map(([id, arr]) => [id, arr.length]));
      const rebuilt = Object.fromEntries(Object.entries(lens).map(([id, n]) => [id, last[id]!.slice(0, n)]));
      if (same(rebuilt, snap) !== null) throw new Error(`sources are not a prefix in ${k} #${i}`);
      list[i] = { sourcesLens: lens };
    });
  }
  // The first two cases compare against modules the server still has (src/analysis/geoMatch, geoCluster): live, not recorded.
  const keep = Object.fromEntries(Object.entries(REC).filter(([k]) => !/normalizeName and matchGeoItem|geoCluster: axis detection/.test(k)));
  const out = path.join(ROOT, 'web/src/charts/maps/__golden__');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'geo.json'), encode({ cases: keep, finals, inputs: INPUTS }) + '\n');
});

// ── The legacy scripts, in one context ──────────────────────────────────────
const LIGHT: Record<string, string> = {
  '--accent': '#2563eb', '--surface': '#ffffff', '--surface-3': '#eaecf0', '--border-2': '#d6dae1', '--border': '#e4e7ec', '--text-faint': '#aeb4bf',
};
const DARK: Record<string, string> = { ...LIGHT, '--surface': '#1c1c20', '--surface-3': '#303038', '--accent': '#3b82f6' };
let vars = LIGHT;
const en = JSON.parse(readFileSync(at('src/i18n/en.json'), 'utf8')) as Record<string, string>;
const t = (key: string, params: Record<string, unknown> = {}) =>
  (en[key] ?? key).replace(/\{(\w+)(?:, plural, one \{(\w+)\} other \{(\w+)\})?\}/g, (_m, k: string, one?: string, many?: string) =>
    one ? (params[k] === 1 ? one : (many as string)) : String(params[k] ?? ''));

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

let L: Record<string, (...a: never[]) => unknown>;
let picked: ((mode: string) => void) | null = null;
beforeAll(() => {
  if (!process.env.GOLDEN_RECORD) return;
  const ctx = vm.createContext({
    document, CustomEvent, setTimeout, clearTimeout, console,
    getCSSVar: (name: string) => vars[name] ?? '',
    t, icon: () => document.createElement('span'), iconOnly: () => {}, openMiniMenu: () => {},
    openValuesMenu: (_b: unknown, _m: string, onPick: (m: string) => void) => { picked = onPick; },
    _fmtVal: (v: number | null) => (v == null ? '' : formatCompact(v)),
    CHART_PALETTE, mapInstances: new Map(), maplibregl: ml,
  });
  vm.runInContext('var window = this;', ctx);
  for (const f of ['geoMatch', 'geoCluster', 'chartValueLabels', 'mapKinds', 'mapRender', 'mapOverlays', 'mapPoints', 'mapHexbin', 'mapFlow', 'mapThumb']) {
    vm.runInContext(readFileSync(at(`renderer/hub/${f}.js`), 'utf8'), ctx, { filename: `${f}.js` });
  }
  L = vm.runInContext(`({ normalizeName, matchGeoItem, geoCluster, valueLabelKeys, isMapChartType, geoChartTypeFor, geoMapFits,
    geoNeedsText, withGeoChartType, getChoroplethColor, buildPeriodGeo, _geoBBox, abbrevFor, fillCentroidsFromBoundaries,
    _renderBubbleMap, _renderChoroplethMap, renderPointMap, renderHexbinMap, renderFlowMap, flowWidth, mapThumbProject, mapThumbFills })`, ctx);
});

// ── Real server replies ─────────────────────────────────────────────────────
type Columns = Array<{ name: string; type: string }>;
const vizData = require(at('src/analysis/vizData.js')) as { buildVizData(c: Columns, r: unknown[][], e: object, f: unknown[]): { data: MapData } };
const mapData = require(at('src/analysis/mapData.js')) as { pointItems(c: Columns, r: unknown[][], e: object): { items: MapGeo['items'] } };
const geoAgg = require(at('src/analysis/geo/geoAgg.js')) as Record<string, (...a: unknown[]) => unknown>;
const fixture = (require(at('scripts/geoFixture.js')) as { geoFixture(): { columns: Columns; rows: unknown[][] } }).geoFixture();
const states = (() => {
  const src = readFileSync(at('assets/geo/us-states.js'), 'utf8');
  return JSON.parse(src.replace(/^[\s\S]*?=\s*/, '').replace(/;\s*$/, '')) as FeatureCollection;
})();
const sample = (() => {
  const [head, ...lines] = readFileSync(at('assets/samples/retail-orders.csv'), 'utf8').trim().split('\n');
  const names = head.split(',');
  const num = new Set(['units', 'unit_price', 'discount', 'revenue', 'profit', 'ship_days']);
  return {
    columns: names.map((name) => ({ name, type: num.has(name) ? 'number' : 'text' })),
    rows: lines.map((l) => l.split(',').map((v, i) => (num.has(names[i]) ? Number(v) : v))),
  };
})();
const INPUTS: Record<string, unknown> = {};
const keepInput = <T,>(k: string, v: T): T => { INPUTS[k] = structuredClone(v); return v; };
const viz = (encoding: object): MapData => keepInput('viz ' + JSON.stringify(encoding), vizData.buildVizData(sample.columns, sample.rows, encoding, []).data);
const byState = (measure: string, series?: string) => viz({ category: 'state', ...(series ? { series } : {}), values: [{ column: measure, aggregation: 'sum' }], geo: { level: 'us_state' } });
const measure = { column: 'weight_kg', aggregation: 'sum' };
const hexData = (): MapData => keepInput('hex', hexData0());
const hexData0 = (): MapData => {
  const spec = { lat: 'lat', lng: 'lon', measure: { agg: 'sum', column: 'weight_kg', label: 'Sum of weight_kg' } };
  return { labels: [], series: [], geo: geoAgg.shapeHexbin(geoAgg.hexGroupsJs(fixture.columns, fixture.rows, spec, []), spec.measure) as MapGeo };
};
const flowData = (): MapData => keepInput('flow', flowData0());
const flowData0 = (): MapData => {
  const spec = { lat: 'wh_lat', lng: 'wh_lon', lat2: 'city_lat', lng2: 'city_lon', from: 'warehouse', to: 'city', measure: { agg: 'sum', column: 'weight_kg', label: 'Sum of weight_kg' } };
  return { labels: [], series: [], geo: geoAgg.shapeFlows(geoAgg.flowGroupsJs(fixture.columns, fixture.rows, spec, []), spec.measure) as MapGeo };
};
const pointData = (): MapData => keepInput('point', pointData0());
const pointData0 = (): MapData => ({
  labels: [], series: [], markColumn: 'city',
  geo: { level: 'point', points: true, items: mapData.pointItems(fixture.columns, fixture.rows, { category: 'city', values: [measure], geo: { level: 'point', lat: 'lat', lon: 'lon', color: 'carrier' } }).items, colorColumn: 'carrier', skipped: 0 },
});

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
const legacyMap = (zoom = 3) => ({ ...fakeMap(zoom), wrap: document.createElement('div') });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Pure helpers ────────────────────────────────────────────────────────────
describe.runIf(process.env.GOLDEN_RECORD)('record: pure helpers equal the desktop', () => {
  it('normalizeName and matchGeoItem over every state shape', () => {
    const names = ['Roanoke City', 'St. Louis County', 'Prince of Wales-Hyder Census Area', 'United States of America', '  New   York (state) ', '', 'James City'];
    for (const n of names) eq(normalizeName(n), L.normalizeName(n as never));
    const items = byState('profit').geo!.items;
    for (const f of states.features) agree(matchGeoItem(items, f.properties), L.matchGeoItem(items as never, f.properties as never));
    // Counties (state + county-vs-city kind disambiguate) and countries (iso2, long official names).
    const counties = JSON.parse(readFileSync(at('assets/geo/us-counties.json'), 'utf8')) as FeatureCollection;
    const cItems = counties.features.filter((_, i) => i % 9 === 0).map((f, i) => ({ name: `${String(f.properties.name)}${i % 3 ? ' County' : ''}`, state: String(f.properties.state), kind: i % 4 ? undefined : String(f.properties.kind), value: i }));
    for (const f of counties.features) agree(matchGeoItem(cItems, f.properties), L.matchGeoItem(cItems as never, f.properties as never));
    const world = JSON.parse(readFileSync(at('assets/geo/world-countries.js'), 'utf8').replace(/^[\s\S]*?=\s*/, '').replace(/;\s*$/, '')) as FeatureCollection;
    const wItems = ['United States of America', 'Russian Federation', 'UK', 'de', 'Congo', 'Korea', 'Niger', 'Guinea', 'Sudan'].map((name, value) => ({ name, value }));
    for (const f of world.features) agree(matchGeoItem(wItems, f.properties), L.matchGeoItem(wItems as never, f.properties as never));
    for (const f of counties.features.slice(0, 400)) eq(normalizeName(String(f.properties.name) + ' Parish'), L.normalizeName((String(f.properties.name) + ' Parish') as never));
    // Pinned divergence from the truth, kept for parity: "virginia" ⊂ "west virginia".
    expect(matchGeoItem(items, { name: 'West Virginia' })?.name).toBe('Virginia');
  });

  it('geoCluster: axis detection and grid clusters at every zoom', () => {
    for (const n of ['lat', 'Latitude', 'pickup_lat', 'lngDeg', 'LONGITUDE', 'long', 'wh_lon', 'flat']) expect(axisOf(n)).toBe((L.geoCluster as never as { axisOf(n: string): unknown }).axisOf(n));
    const sampler = (name: string) => fixture.rows.map((r) => r[fixture.columns.findIndex((c) => c.name === name)]);
    const lc = L.geoCluster as never as { detectLatLon: typeof detectLatLon; gridCluster: typeof gridCluster };
    agree(detectLatLon(fixture.columns, sampler), lc.detectLatLon(fixture.columns, sampler));
    const pts = pointData().geo!.items as Array<{ lat: number; lng: number; value: number }>;
    for (let z = 0; z <= 12; z++) agree(gridCluster(pts, z), lc.gridCluster(pts, z));
    agree(gridCluster(pts.slice(0, 500), 4), lc.gridCluster(pts.slice(0, 500), 4)); // below the threshold: no clustering
  });

  it('mapKinds, in the desktop English', () => {
    const geos = [null, byState('profit').geo, hexData().geo, flowData().geo];
    for (const type of ['map_bubble', 'map_choropleth', 'map_hexbin', 'map_flow', 'column']) {
      eq(isMapChartType(type), L.isMapChartType(type as never));
      for (const has of [true, false]) eq(geoNeedsText(type, has), L.geoNeedsText(type as never, has as never));
      for (const g of geos) eq(geoMapFits(type, g), L.geoMapFits(type as never, g as never));
    }
    for (const g of geos) {
      eq(geoChartTypeFor(g), L.geoChartTypeFor(g as never));
      agree(withGeoChartType(['column', 'bar'], g), L.withGeoChartType(['column', 'bar'] as never, g as never));
    }
  });

  it('the colour ramp, both themes, and the flow width scale', () => {
    for (const v of [LIGHT, DARK]) {
      vars = v;
      for (let i = -5; i <= 105; i++) eq(choroplethColor(i / 100, isDarkHex(v['--surface'])), L.getChoroplethColor((i / 100) as never));
    }
    vars = LIGHT;
    for (const v of [null, -1, 0, 0.5, 3, 18.8e3, 1e9]) for (const max of [0, 1, 18.8e3]) eq(flowWidth(v, max), L.flowWidth(v as never, max as never));
  });

  it('bboxes, abbreviations, centroids and per-period values', () => {
    const items = byState('profit').geo!.items;
    for (const f of states.features) {
      agree(geoBBox(f.geometry), L._geoBBox(f.geometry as never));
      for (const level of ['us_state', 'country', 'us_county']) eq(abbrevFor({ name: String(f.properties.name) }, f.properties, level), L.abbrevFor({ name: f.properties.name } as never, f.properties as never, level as never));
    }
    const legacy = clone(items);
    L.fillCentroidsFromBoundaries(legacy as never, states as never);
    agree(withCentroids(items, states.features), legacy);
    expect(items.every((i) => i.lat === undefined)).toBe(true); // the reply is never mutated
    const ts = byState('profit', 'category');
    expect(ts.dataShape).toBe('time_series');
    const p = buildPeriodGeo(ts.labels, ts.series, ts.geo!.items);
    const lp = L.buildPeriodGeo(ts.labels as never, ts.series as never, ts.geo!.items as never) as typeof p;
    agree([p.periods, p.minVal, p.maxVal], [lp.periods, lp.minVal, lp.maxVal]);
    for (let i = 0; i < p.periods.length; i++) agree(p.itemsForPeriod(i), lp.itemsForPeriod(i));
  });

  it('value-label picks and thumbnail projection / fills', () => {
    const rows = [[3, null, 9, -1, 9], [], ['x', 2]];
    for (const mode of ['off', 'all', 'maxmin', 'max', 'min', '']) agree([...valueLabelKeys(mode, rows)], [...(L.valueLabelKeys(mode as never, rows as never) as Set<string>)]);
    const proj = mapThumbProject([-125, 24, -66, 50], 160, 96, 2);
    const lproj = L.mapThumbProject([-125, 24, -66, 50] as never, 160 as never, 96 as never, 2 as never) as typeof proj;
    for (const [x, y] of [[-125, 24], [-95, 39], [-66, 50]]) agree(proj(x, y), lproj(x, y));
    const items = byState('profit').geo!.items;
    agree(mapThumbFills(states.features, items, '', (k) => `c${k}`), L.mapThumbFills(states.features as never, items as never, '' as never, ((k: number) => `c${k}`) as never));
  });
});

// ── Every kind, drawn by both ───────────────────────────────────────────────
describe.runIf(process.env.GOLDEN_RECORD)('record: every map kind draws the same marks as the desktop', () => {
  for (const v of [LIGHT, DARK]) {
    const name = v === LIGHT ? 'light' : 'dark';

    it(`region map (${name}): fills, Max & min labels, camera — then Values → All`, () => {
      vars = v;
      const data = byState('profit');
      const a = legacyMap();
      const matched = L._renderChoroplethMap(a.map as never, a.wrap as never, data.geo as never, states as never, null as never, data as never);
      const b = port(data, 'map_choropleth', states);
      agreeSources(b.sources, a.sources);
      agree(b.live(), a.live());
      agree(b.camera, a.camera);
      eq(b.drawn.overlay.stats.matched, String(matched));
      (a.wrap.querySelector('.cv-values-btn') as HTMLButtonElement).click();
      picked!('all');
      b.drawn.setValueMode!('all');
      agree(b.live(), a.live());
      vars = LIGHT;
    });
  }

  it('region map stepping through periods (a time-series reply)', () => {
    const data = byState('profit', 'category');
    const a = legacyMap();
    L._renderChoroplethMap(a.map as never, a.wrap as never, data.geo as never, states as never, L.buildPeriodGeo(data.labels as never, data.series as never, data.geo!.items as never) as never, data as never);
    const b = port(data, 'map_choropleth', states);
    const select = a.wrap.querySelector('select') as HTMLSelectElement;
    for (const idx of [0, 1, 2]) {
      select.value = String(idx);
      select.dispatchEvent(new Event('change'));
      b.drawn.setPeriod!(idx);
      agreeSources(b.sources, a.sources);
      agree(b.live(), a.live());
    }
  });

  it('bubble map at region centroids', () => {
    const data = byState('revenue');
    const a = legacyMap();
    const items = clone(data.geo!.items);
    L.fillCentroidsFromBoundaries(items as never, states as never);
    L._renderBubbleMap(a.map as never, a.wrap as never, { ...data.geo, items } as never, null as never, data as never);
    const b = port(data, 'map_bubble', states);
    agreeSources(b.sources, a.sources);
    agree(b.live(), a.live());
    agree(b.camera, a.camera);
  });

  it('point map: clusters and singles, re-clustered on zoom', () => {
    const data = pointData();
    const a = legacyMap();
    L.renderPointMap(a.map as never, a.wrap as never, a.wrap as never, data.geo as never, data as never);
    const b = port(data, 'map_bubble', null);
    for (const z of [3, 6, 9, 14]) {
      a.zoomTo(z);
      b.zoomTo(z);
      agreeSources(b.sources, a.sources);
      agree(b.live(), a.live());
    }
    agree(b.camera, a.camera);
    eqDeep(b.drawn.overlay.colorLegend?.rows, [...a.wrap.querySelectorAll('.cv-map-legend--colors .cv-map-legend-row')].map((r) => [r.textContent, r.querySelector('circle')?.getAttribute('fill')]));
  });

  it('hexbin map: the level for each zoom', async () => {
    const data = hexData();
    const a = legacyMap();
    L.renderHexbinMap(a.map as never, a.wrap as never, data.geo as never, data as never);
    const b = port(data, 'map_hexbin', null);
    agreeSources(b.sources, a.sources);
    for (const z of [1, 5, 8, 12]) {
      a.zoomTo(z);
      b.zoomTo(z);
      await sleep(150); // both debounce the level swap by 120 ms
      agreeSources(b.sources, a.sources);
      eq(b.overlay().notes?.info, a.wrap.querySelector('.geo-map-note')?.textContent);
    }
    agree(b.camera, a.camera);
  });

  it('flow map: routes heaviest-last and their ends', () => {
    const data = flowData();
    const a = legacyMap();
    L.renderFlowMap(a.map as never, a.wrap as never, data.geo as never, data as never);
    const b = port(data, 'map_flow', null);
    agreeSources(b.sources, a.sources);
    agree(b.camera, a.camera);
    eq(b.drawn.overlay.notes?.info, a.wrap.querySelector('.geo-map-note')?.textContent);
  });
});
