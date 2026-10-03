// Drawing each map kind onto a loaded MapLibre map — the imperative half of
// mapRender / mapPoints / mapHexbin / mapFlow. Everything a mark looks like is
// decided in ./features.ts (pure); this file adds sources, layers, tooltips
// and DOM markers, and reports what the React overlay (legend, notes, the
// Values and period controls) should show through `emit`.

import { formatCompact } from '../../../../src/app/format.ts';
import { buildPeriodGeo, extendBBox, hasCoords, withCentroids, type PeriodGeo } from './geometry';
import { gridCluster } from './geoCluster';
import { normalizeName } from './geoMatch';
import { FLOW_W_MAX, FLOW_W_MIN, pointColors, rampStops } from './colors';
import {
  BUBBLE_R, POINT_R, bubbleLayer, choroplethLayer, clusterRadius, dataToTSV, flowLayer, geoMapTable, hexLayer,
  hexLevelFor, pointLayer, valueLabelKeys, type LabelEntry, type ValueMode,
} from './features';
import { abbrevFor } from './geometry';
import { fitBBox, hoverPopup, tipContent, valueMarker, type MapLibre, type MlMap } from './maplibre';
import type { ExpressionSpecification } from 'maplibre-gl';
import type { BBox, Feature, GeoItem, HexLevel, MapData } from './types';

export interface MapTheme {
  accent: string;
  surface: string;
  noData: string;
  noDataBorder: string;
  border: string;
  muted: string;
  palette: readonly string[];
  dark: boolean;
}

export type Legend =
  | { kind: 'size'; title: string; min: string; max: string; color: string; r: readonly [number, number] }
  | { kind: 'ramp'; title: string; min: string; max: string; stops: readonly string[] }
  | { kind: 'flow'; title: string; rows: Array<[number, string]>; color: string };

export interface Overlay {
  legend?: Legend;
  colorLegend?: { title: string; rows: Array<[string, string]> };
  /** The "Couldn't place …" line. */
  unmatched?: string;
  notes?: { info: string; warn: string };
  /** Over the (still drawn) basemap: why there is nothing on it. */
  empty?: string;
  periods?: string[];
  period?: number;
  valueMode?: ValueMode;
  /** "Copy data" text. */
  tsv: string;
  /** Read by the e2e and the map's accessible description: points, clusters, hexes, flows, matched. */
  stats: Record<string, string>;
}

export interface DrawContext {
  ml: MapLibre;
  map: MlMap;
  data: MapData;
  type: string;
  /** Region boundaries for a choropleth (or a bubble map's centroids). */
  features: readonly Feature[] | null;
  theme: MapTheme;
  onMark?: (column: string | undefined, category: string) => void;
  emit: (patch: Partial<Overlay>) => void;
}

export interface Drawn {
  overlay: Overlay;
  setValueMode?: (mode: ValueMode) => void;
  setPeriod?: (idx: number) => void;
}

const fmt = (v: number): string => formatCompact(v);
const loc = (v: unknown): string => (typeof v === 'number' ? v.toLocaleString() : 'n/a');
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function mark(ctx: DrawContext, category: unknown): void {
  if (category === undefined || category === null || category === '' || !ctx.onMark) return;
  ctx.onMark(ctx.data.markColumn, String(category));
}

function periodInfo(data: MapData, items: readonly GeoItem[]): PeriodGeo | null {
  const ts = data.dataShape === 'time_series' && Array.isArray(data.series) && data.series.length >= 2 && Array.isArray(data.labels) && data.labels.length > 0;
  return ts ? buildPeriodGeo(data.labels, data.series, items) : null;
}

/** DOM value labels, rebuilt on a Values-mode or period change. */
function labeller(ctx: DrawContext, entries: () => LabelEntry[]) {
  let markers: Array<{ remove(): void }> = [];
  let mode: ValueMode = 'maxmin'; // default: the highest and lowest region
  const rebuild = (): void => {
    markers.forEach((m) => m.remove());
    markers = [];
    if (mode === 'off') return;
    const list = entries();
    const keys = valueLabelKeys(mode, [list.map((e) => e.value)]);
    list.forEach((e, i) => {
      if (keys.has('0:' + i)) markers.push(valueMarker(ctx.ml, ctx.map, e.lng, e.lat, e.text));
    });
  };
  return {
    rebuild,
    set(m: ValueMode) {
      mode = m;
      rebuild();
      ctx.emit({ valueMode: m });
    },
  };
}

function drawBubble(ctx: DrawContext): Drawn {
  const { map, data, theme } = ctx;
  const geo = data.geo!;
  const items = geo.points ? geo.items : withCentroids(geo.items, ctx.features);
  const placeable = items.filter(hasCoords);
  const overlay: Overlay = { tsv: dataToTSV(data), stats: { points: String(placeable.length) } };
  if (!placeable.length) return { overlay: { ...overlay, empty: 'No lat/lng coordinates in geo data for bubble map.' } };
  const periods = periodInfo(data, items);
  const usePeriods = !!(periods && periods.periods.length >= 2);
  const vs = placeable.map((i) => i.value as number);
  const [min, max] = periods ? [periods.minVal, periods.maxVal] : [Math.min(...vs), Math.max(...vs)];
  let periodIdx = usePeriods ? periods!.periods.length - 1 : 0;
  const now = () => (usePeriods ? periods!.itemsForPeriod(periodIdx) : items).filter(hasCoords);
  let fitted = false;
  const SRC = 'cv-bubbles';
  const draw = (): void => {
    const { fc, bbox } = bubbleLayer(now(), min, max);
    const src = map.getSource(SRC) as { setData(d: unknown): void } | undefined;
    if (src) src.setData(fc);
    else {
      map.addSource(SRC, { type: 'geojson', data: fc as GeoJSON.FeatureCollection });
      map.addLayer({
        id: 'cv-bubbles-circles', type: 'circle', source: SRC,
        paint: {
          'circle-radius': ['to-number', ['get', '__r'], BUBBLE_R[0]], 'circle-color': theme.accent, 'circle-opacity': 0.55,
          'circle-stroke-color': theme.accent, 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.8,
        },
      });
      hoverPopup(ctx.ml, map, 'cv-bubbles-circles', (p) => tipContent(String(p.__name ?? ''), [loc(p.__val)]));
      map.on('click', 'cv-bubbles-circles', (e) => mark(ctx, e.features?.[0]?.properties?.__name));
    }
    if (!fitted && bbox) {
      fitted = true;
      fitBBox(map, bbox, 20, 6);
    }
  };
  const labels = labeller(ctx, () =>
    now()
      .filter((i) => typeof i.value === 'number')
      .map((i) => ({ lng: i.lng, lat: i.lat, value: i.value as number, text: `${abbrevFor(i, {}, geo.level)} ${fmt(i.value as number)}` })),
  );
  draw();
  labels.rebuild();
  const unplaced = items.filter((i) => !hasCoords(i)).map((i) => i.name);
  return {
    overlay: {
      ...overlay,
      legend: { kind: 'size', title: 'Size = value', min: fmt(min), max: fmt(max), color: theme.accent, r: BUBBLE_R },
      unmatched: unplaced.length ? `Couldn't place: ${unplaced.join(', ')}` : undefined,
      periods: usePeriods ? periods!.periods : undefined,
      period: periodIdx,
      valueMode: 'maxmin',
    },
    setValueMode: labels.set,
    setPeriod: (idx) => {
      periodIdx = idx;
      draw();
      labels.rebuild();
      ctx.emit({ period: idx });
    },
  };
}

function drawChoropleth(ctx: DrawContext): Drawn {
  const { map, data, theme } = ctx;
  const geo = data.geo!;
  const features = ctx.features || [];
  const periods = periodInfo(data, geo.items);
  const usePeriods = !!(periods && periods.periods.length >= 2);
  const vs = geo.items.map((i) => i.value).filter((v): v is number => typeof v === 'number');
  const [min, max] = periods ? [periods.minVal, periods.maxVal] : [vs.length ? Math.min(...vs) : 0, vs.length ? Math.max(...vs) : 1];
  let periodIdx = usePeriods ? periods!.periods.length - 1 : 0;
  let entries: LabelEntry[] = [];
  let matched = new Set<string>();
  let fitted = false;
  const SRC = 'cv-choropleth';
  const draw = (): void => {
    const layer = choroplethLayer(features, usePeriods ? periods!.itemsForPeriod(periodIdx) : geo.items, geo.level, { min, max, dark: theme.dark, noData: theme.noData }, fmt);
    entries = layer.labels;
    matched = layer.matched;
    const src = map.getSource(SRC) as { setData(d: unknown): void } | undefined;
    if (src) src.setData(layer.fc);
    else {
      const has: ExpressionSpecification = ['to-boolean', ['get', '__has']];
      map.addSource(SRC, { type: 'geojson', data: layer.fc as GeoJSON.FeatureCollection });
      map.addLayer({
        id: 'cv-choropleth-fill', type: 'fill', source: SRC,
        paint: { 'fill-color': ['to-color', ['get', '__color'], theme.noData], 'fill-opacity': ['case', has, 0.75, 0.4] },
      });
      map.addLayer({
        id: 'cv-choropleth-line', type: 'line', source: SRC,
        paint: { 'line-color': ['case', has, theme.border, theme.noDataBorder], 'line-width': ['case', has, 0.5, 0.4] },
      });
      hoverPopup(ctx.ml, map, 'cv-choropleth-fill', (p) =>
        tipContent(String(p.__name ?? ''), [p.__matched === true || p.__matched === 'true' ? loc(p.__val) : ['No data', true]]),
      );
      map.on('click', 'cv-choropleth-fill', (e) => mark(ctx, e.features?.[0]?.properties?.__item));
    }
    if (!fitted) {
      fitted = true; // keep the viewer's zoom when the period changes
      if (layer.matchedBBox) fitBBox(map, layer.matchedBBox, 12, 8);
      else if (geo.level === 'us_state' || geo.level === 'us_county') map.jumpTo({ center: [-95, 39], zoom: 4 });
      else if (layer.allBBox) fitBBox(map, layer.allBBox, 8, 5);
    }
  };
  const labels = labeller(ctx, () => entries);
  draw();
  labels.rebuild();
  const unmatched = geo.items.filter((i) => !matched.has(normalizeName(i.name))).map((i) => i.name);
  return {
    overlay: {
      legend: { kind: 'ramp', title: 'Value', min: fmt(min), max: fmt(max), stops: rampStops(theme.dark) },
      unmatched: unmatched.length ? `Couldn't place: ${unmatched.join(', ')}` : undefined,
      periods: usePeriods ? periods!.periods : undefined,
      period: periodIdx,
      valueMode: 'maxmin',
      tsv: dataToTSV(data),
      stats: { matched: String(matched.size) },
    },
    setValueMode: labels.set,
    setPeriod: (idx) => {
      periodIdx = idx;
      draw();
      labels.rebuild();
      ctx.emit({ period: idx });
    },
  };
}

function unplacedText(u: { count: number; values: string[] }): string {
  const more = u.count > u.values.length ? `, and ${u.count - u.values.length} more` : '';
  return `Couldn't place ${u.count}: ${u.values.join(', ')}${more}`;
}

function drawPoints(ctx: DrawContext): Drawn {
  const { ml, map, data, theme } = ctx;
  const geo = data.geo!;
  const items = geo.items.filter(hasCoords);
  const base: Overlay = { tsv: dataToTSV(data), stats: { points: '0', clusters: '0' } };
  if (!items.length) {
    return { overlay: { ...base, empty: 'None of these values could be placed on the map.', unmatched: geo.unmatched ? unplacedText(geo.unmatched) : undefined } };
  }
  const values = items.map((i) => (typeof i.value === 'number' ? i.value : 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const colors = pointColors(items, { accent: theme.accent, muted: theme.muted, palette: theme.palette, dark: theme.dark });
  let markers: Array<{ remove(): void }> = [];
  const SRC = 'cv-points';
  const LAYER = 'cv-points-circles';
  const draw = (): void => {
    const zoom = map.getZoom();
    const cells = gridCluster(items, zoom);
    markers.forEach((m) => m.remove());
    markers = [];
    let clusters = 0;
    for (const c of cells) {
      if (c.count <= 1) continue;
      clusters++;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'cv-map-cluster';
      el.textContent = fmt(c.count);
      el.style.width = el.style.height = clusterRadius(c.count) * 2 + 'px';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        map.easeTo({ center: [c.lng, c.lat], zoom: Math.min(18, Math.floor(zoom) + 2), duration: 0 });
      });
      markers.push(new ml.Marker({ element: el, anchor: 'center' }).setLngLat([c.lng, c.lat]).addTo(map));
      // After the Marker: its constructor stamps a generic "Map marker" label over ours.
      el.setAttribute('aria-label', `${c.count.toLocaleString()} points — zoom in`);
    }
    const fc = pointLayer(items, cells, colors, { min, max, clusterColor: theme.accent });
    const src = map.getSource(SRC) as { setData(d: unknown): void } | undefined;
    if (src) src.setData(fc);
    else {
      map.addSource(SRC, { type: 'geojson', data: fc as GeoJSON.FeatureCollection });
      map.addLayer({
        id: LAYER, type: 'circle', source: SRC, filter: ['>', ['to-number', ['get', '__r']], 0],
        paint: {
          'circle-radius': ['to-number', ['get', '__r'], POINT_R[0]], 'circle-color': ['to-color', ['get', '__c'], theme.accent],
          'circle-opacity': 0.72, 'circle-stroke-color': theme.surface, 'circle-stroke-width': 1,
        },
      });
      hoverPopup(ml, map, LAYER, (p) => {
        const lines: Array<string | [string, true]> = [typeof p.__val === 'number' ? p.__val.toLocaleString() : ''];
        if (p.__color) lines.push([`${geo.colorColumn || 'colour'}: ${String(p.__color)}`, true]);
        return tipContent(p.__name ? String(p.__name) : '', lines);
      });
      map.on('click', LAYER, (e) => mark(ctx, e.features?.[0]?.properties?.__name));
    }
    ctx.emit({ stats: { points: String(cells.length - clusters), clusters: String(clusters) } });
  };
  let bbox: BBox | null = null;
  for (const it of items) bbox = extendBBox(bbox, [it.lng, it.lat, it.lng, it.lat]);
  if (bbox) fitBBox(map, bbox, 24, 12);
  draw();
  map.on('zoomend', draw);
  const overlay: Overlay = { ...base };
  if (max > min) overlay.legend = { kind: 'size', title: 'Size = value', min: fmt(min), max: fmt(max), color: theme.accent, r: POINT_R };
  if (colors.legend) overlay.colorLegend = { title: geo.colorColumn || 'Colour', rows: colors.legend };
  if (geo.unmatched && geo.unmatched.count) overlay.unmatched = unplacedText(geo.unmatched);
  else if (geo.skipped) overlay.unmatched = `Couldn't place: ${geo.skipped.toLocaleString()} rows with no usable coordinates`;
  return { overlay };
}

function drawHexbin(ctx: DrawContext): Drawn {
  const { map, data, theme } = ctx;
  const hex = data.geo!.hex!;
  const levels = Array.isArray(hex.levels) ? hex.levels.filter((l) => l && Array.isArray(l.hexes)) : [];
  const tsv = dataToTSV(geoMapTable(data, 'hexbin'));
  if (!hex.points || !levels.length) {
    const empty = hex.skipped ? `None of the ${hex.skipped.toLocaleString()} rows has a latitude and longitude the map can place.` : 'No rows to place on the map.';
    return { overlay: { empty, tsv, stats: { hexes: '0' } } };
  }
  let current: HexLevel | null = null;
  const view = (level: HexLevel): Partial<Overlay> => {
    const { fc, min, max } = hexLayer(level, theme.dark, theme.noData);
    const src = map.getSource('cv-hex') as { setData(d: unknown): void } | undefined;
    if (src) src.setData(fc);
    else {
      map.addSource('cv-hex', { type: 'geojson', data: fc as GeoJSON.FeatureCollection });
      map.addLayer({ id: 'cv-hex-fill', type: 'fill', source: 'cv-hex', paint: { 'fill-color': ['to-color', ['get', '__color'], '#8aaedd'], 'fill-opacity': 0.78 } });
      map.addLayer({ id: 'cv-hex-line', type: 'line', source: 'cv-hex', paint: { 'line-color': theme.surface, 'line-width': 0.6, 'line-opacity': 0.8 } });
      hoverPopup(ctx.ml, map, 'cv-hex-fill', (p) => {
        const v = p.__val === null || p.__val === undefined || p.__val === 'null' ? 'no data' : fmt(Number(p.__val));
        return tipContent(`${hex.label}: ${v}`, [[`${plural(Number(p.__n), 'point', 'points')} in this hexagon`, true]]);
      });
    }
    current = level;
    const capped = hex.dropped.length > 0 && levels.indexOf(level) === levels.length - 1 && map.getZoom() + 1 > level.zoom + 2;
    const warn: string[] = [];
    if (hex.skipped) warn.push(`${hex.skipped.toLocaleString()} rows had no usable coordinates`);
    if (capped) warn.push(`finer levels exceed ${hex.maxHexes.toLocaleString()} hexagons — this is the finest drawn`);
    return {
      legend: { kind: 'ramp', title: hex.label, min: fmt(min), max: fmt(max), stops: rampStops(theme.dark) },
      notes: {
        info: `${hex.points.toLocaleString()} points · ${level.hexes.length.toLocaleString()} hexagons · level ${level.res + 1} of ${levels.length + hex.dropped.length}`,
        warn: warn.join(' · '),
      },
      stats: { hexes: String(level.hexes.length), hexRes: String(level.res) },
    };
  };
  let bbox: BBox | null = null;
  for (const h of levels[0].hexes) bbox = extendBBox(bbox, [h.lng, h.lat, h.lng, h.lat]);
  if (bbox) fitBBox(map, bbox, 32, 12);
  const first = view(hexLevelFor(levels, map.getZoom()) as HexLevel);
  let timer: ReturnType<typeof setTimeout> | null = null;
  map.on('zoomend', () => {
    if (timer !== null) clearTimeout(timer);
    // Debounced: a pinch must not rebuild the layer a dozen times.
    timer = setTimeout(() => {
      timer = null;
      const next = hexLevelFor(levels, map.getZoom());
      if (next && next !== current) ctx.emit(view(next));
    }, 120);
  });
  return { overlay: { tsv, stats: {}, ...first } };
}

function drawFlow(ctx: DrawContext): Drawn {
  const { map, data, theme } = ctx;
  const flow = data.geo!.flow!;
  const flows = Array.isArray(flow.flows) ? flow.flows : [];
  const tsv = dataToTSV(geoMapTable(data, 'flow'));
  if (!flows.length) {
    const empty = flow.skipped ? `None of the ${flow.skipped.toLocaleString()} rows has an origin and a destination the map can place.` : 'No routes to draw.';
    return { overlay: { empty, tsv, stats: { flows: '0' } } };
  }
  const { lines, ends, max, bbox } = flowLayer(flows);
  map.addSource('cv-flow', { type: 'geojson', data: lines as GeoJSON.FeatureCollection });
  map.addLayer({
    id: 'cv-flow-lines', type: 'line', source: 'cv-flow', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': theme.accent, 'line-opacity': 0.62, 'line-width': ['to-number', ['get', '__w'], FLOW_W_MIN] },
  });
  map.addSource('cv-flow-ends', { type: 'geojson', data: ends as GeoJSON.FeatureCollection });
  map.addLayer({
    id: 'cv-flow-ends', type: 'circle', source: 'cv-flow-ends',
    paint: { 'circle-radius': 4, 'circle-color': ['case', ['==', ['get', '__kind'], 'origin'], theme.accent, theme.surface], 'circle-stroke-color': theme.accent, 'circle-stroke-width': 1.6 },
  });
  hoverPopup(ctx.ml, map, 'cv-flow-lines', (p) => {
    const v = p.__val === null || p.__val === undefined || p.__val === 'null' ? 'no data' : fmt(Number(p.__val));
    return tipContent(String(p.__name ?? ''), [`${flow.label}: ${v}`, [plural(Number(p.__n), 'row', 'rows'), true]]);
  });
  hoverPopup(ctx.ml, map, 'cv-flow-ends', (p) => tipContent(String(p.__name ?? ''), [[p.__kind === 'origin' ? 'Origin' : 'Destination', true]]));
  if (bbox) fitBBox(map, bbox, 40, 10);
  const info =
    flow.routes > flows.length
      ? `Showing the top ${flows.length.toLocaleString()} of ${flow.routes.toLocaleString()} routes by ${flow.label.toLowerCase()}`
      : `${plural(flows.length, 'route', 'routes')} · ${flow.points.toLocaleString()} rows`;
  return {
    overlay: {
      legend: { kind: 'flow', title: flow.label, color: theme.accent, rows: max > 0 ? [[FLOW_W_MIN, 'low'], [FLOW_W_MAX, fmt(max)]] : [[FLOW_W_MIN, 'each route']] },
      notes: { info, warn: flow.skipped ? `${flow.skipped.toLocaleString()} rows had no usable origin or destination` : '' },
      tsv,
      stats: { flows: String(flows.length) },
    },
  };
}

/** Draws `ctx.data` as `ctx.type` and returns the overlay to show over it. */
export function drawMap(ctx: DrawContext): Drawn {
  const geo = ctx.data.geo!;
  if (geo.points) return drawPoints(ctx);
  if (geo.hex) return drawHexbin(ctx);
  if (geo.flow) return drawFlow(ctx);
  return ctx.type === 'map_bubble' ? drawBubble(ctx) : drawChoropleth(ctx);
}
