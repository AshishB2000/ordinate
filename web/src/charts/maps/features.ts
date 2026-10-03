// What each map kind hands MapLibre: GeoJSON built from the reply, with the
// colour and size of every mark stamped on as properties the paint
// expressions read back. PURE — split from the desktop's draw functions
// (mapRender / mapPoints / mapHexbin / mapFlow) so geo.test.ts can hold each
// equal to the desktop's own output, and draw.ts only talks to the map.

import { choroplethColor, flowWidth, unit, type PointColors } from './colors';
import { abbrevFor, bboxCenter, extendBBox, geoBBox, hasCoords } from './geometry';
import { matchGeoItem, normalizeName } from './geoMatch';
import type { Cluster } from './geoCluster';
import type { BBox, Feature, FeatureCollection, FlowRoute, GeoItem, HexLevel, MapData } from './types';

const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const point = (lng: number, lat: number, properties: Record<string, unknown>): Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties,
});

export const BUBBLE_R: readonly [number, number] = [5, 30];

/** Bubbles: one circle per placed item, radius by value between BUBBLE_R. */
export function bubbleLayer(items: readonly GeoItem[], minVal: number, maxVal: number): { fc: FeatureCollection; bbox: BBox | null } {
  let bbox: BBox | null = null;
  const features = items.filter(hasCoords).map((item) => {
    const t = unit(item.value as number, minVal, maxVal);
    bbox = extendBBox(bbox, [item.lng, item.lat, item.lng, item.lat]);
    return point(item.lng, item.lat, {
      __r: BUBBLE_R[0] + Math.max(0, Math.min(1, t)) * (BUBBLE_R[1] - BUBBLE_R[0]),
      __name: String(item.name == null ? '' : item.name),
      __val: typeof item.value === 'number' ? item.value : null,
    });
  });
  return { fc: fc(features), bbox };
}

export interface LabelEntry {
  lng: number;
  lat: number;
  text: string;
  value: number;
}

export interface ChoroplethLayer {
  fc: FeatureCollection;
  /** normalizeName of every item some feature matched. */
  matched: Set<string>;
  matchedBBox: BBox | null;
  allBBox: BBox | null;
  /** Value-label anchors in feature order, so valueLabelKeys indices line up. */
  labels: LabelEntry[];
}

/** Regions: every boundary feature, filled from its matched item's value (or the no-data fill). */
export function choroplethLayer(
  features: readonly Feature[],
  items: readonly GeoItem[],
  level: string,
  scale: { min: number; max: number; dark: boolean; noData: string },
  fmt: (v: number) => string,
): ChoroplethLayer {
  const matched = new Set<string>();
  let matchedBBox: BBox | null = null;
  let allBBox: BBox | null = null;
  const labels: LabelEntry[] = [];
  const out = features.map((feat): Feature => {
    const props = (feat && feat.properties) || {};
    const item = matchGeoItem(items, props);
    const hasValue = !!(item && typeof item.value === 'number');
    const bb = geoBBox(feat && feat.geometry);
    allBBox = extendBBox(allBBox, bb);
    const color = hasValue ? choroplethColor(unit(item!.value as number, scale.min, scale.max), scale.dark) : scale.noData;
    if (item) {
      matched.add(normalizeName(item.name));
      matchedBBox = extendBBox(matchedBBox, bb);
    }
    if (hasValue && bb) {
      const c = bboxCenter(bb);
      labels.push({ lng: c.lng, lat: c.lat, value: item!.value as number, text: `${abbrevFor(item!, props, level)} ${fmt(item!.value as number)}` });
    }
    return {
      type: 'Feature',
      geometry: feat.geometry,
      properties: {
        ...props,
        __color: color,
        __has: hasValue,
        __matched: !!item,
        __item: item ? String(item.name) : '',
        __name: String(props.name || ''),
        __val: hasValue ? item!.value : null,
      },
    };
  });
  return { fc: fc(out), matched, matchedBBox, allBBox, labels };
}

export const POINT_R: readonly [number, number] = [4, 18];

/** Points at one zoom: single points as circles; a cluster as a radius-0 placeholder (its count is a DOM marker). */
export function pointLayer(
  items: ReadonlyArray<GeoItem & { lat: number; lng: number }>,
  cells: readonly Cluster[],
  colors: PointColors,
  range: { min: number; max: number; clusterColor: string },
): FeatureCollection {
  return fc(
    cells.map((c) => {
      if (c.count > 1 || c.index === undefined) return point(c.lng, c.lat, { __r: 0, __c: range.clusterColor });
      const it = items[c.index];
      const tv = unit(it.value as number, range.min, range.max);
      return point(it.lng, it.lat, {
        __r: POINT_R[0] + Math.max(0, Math.min(1, tv)) * (POINT_R[1] - POINT_R[0]),
        __c: colors.of(it),
        __name: it.name,
        __val: it.value,
        __color: it.color == null ? '' : String(it.color),
      });
    }),
  );
}

/** Cluster marker radius in px: grows with log2 of the count, capped. */
export const clusterRadius = (count: number): number => Math.min(24, 9 + Math.log2(count) * 1.8);

/** The hexbin level to draw at `zoom`: the finest whose drawing zoom is ≤ zoom + 1, else the coarsest. */
export function hexLevelFor(levels: readonly HexLevel[], zoom: number): HexLevel | null {
  let pick: HexLevel | null = levels[0] || null;
  for (const l of levels) if (l.zoom <= zoom + 1 && (!pick || l.zoom > pick.zoom)) pick = l;
  return pick;
}

/** One level's hexagons, coloured on the ramp over that level's own range. */
export function hexLayer(level: HexLevel, dark: boolean, none: string): { fc: FeatureCollection; min: number; max: number } {
  const vals = level.hexes.map((h) => h.value).filter((v): v is number => typeof v === 'number');
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals) : 1;
  const features = level.hexes.map((h): Feature => {
    const ring: number[][] = [];
    for (let i = 0; i < h.ring.length; i += 2) ring.push([h.ring[i], h.ring[i + 1]]);
    ring.push(ring[0]);
    const has = typeof h.value === 'number';
    return {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { __id: h.id, __n: h.n, __val: has ? h.value : null, __color: has ? choroplethColor(unit(h.value as number, min, max), dark) : none },
    };
  });
  return { fc: fc(features), min, max };
}

/** Routes, heaviest drawn last (on top), and their end dots — an origin wins over a destination at the same spot. */
export function flowLayer(flows: readonly FlowRoute[]): { lines: FeatureCollection; ends: FeatureCollection; max: number; bbox: BBox | null } {
  const max = Math.max(0, ...flows.map((f) => (typeof f.value === 'number' ? f.value : 0)));
  const order = flows.map((_, i) => i).sort((a, b) => (flows[a].value ?? -Infinity) - (flows[b].value ?? -Infinity) || a - b);
  const lines = order.map((i): Feature => {
    const f = flows[i];
    const coords: number[][] = [];
    for (let k = 0; k < f.path.length; k += 2) coords.push([f.path[k], f.path[k + 1]]);
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { __w: flowWidth(f.value, max), __name: f.name, __val: f.value, __n: f.n } };
  });
  const ends = new Map<string, Feature>();
  let bbox: BBox | null = null;
  for (const f of flows) {
    ends.set('o' + f.o.join(','), point(f.o[0], f.o[1], { __kind: 'origin', __name: f.from }));
    if (!ends.has('o' + f.d.join(','))) ends.set('d' + f.d.join(','), point(f.d[0], f.d[1], { __kind: 'dest', __name: f.to }));
    bbox = extendBBox(extendBBox(bbox, [f.o[0], f.o[1], f.o[0], f.o[1]]), [f.d[0], f.d[1], f.d[0], f.d[1]]);
  }
  return { lines: fc(lines), ends: fc([...ends.values()]), max, bbox };
}

export type ValueMode = 'off' | 'all' | 'maxmin' | 'max' | 'min';
export const VALUE_MODES: ReadonlyArray<[ValueMode, string]> = [
  ['off', 'Off'], ['all', 'All'], ['maxmin', 'Max & min'], ['max', 'Max'], ['min', 'Min'],
];

/**
 * Which marks get a permanent value label: keys "series:index". The maps pass
 * one series. Ported from renderer/hub/chartValueLabels.ts (the chart port,
 * T1.1, owns the shared copy; dedupe when both land).
 */
export function valueLabelKeys(mode: string, values: ReadonlyArray<ReadonlyArray<unknown>>): Set<string> {
  const keys = new Set<string>();
  if (!mode || mode === 'off' || !Array.isArray(values) || !values.length) return keys;
  const S = values.length;
  const C = Math.max(0, ...values.map((r) => (Array.isArray(r) ? r.length : 0)));
  const num = (s: number, c: number): number | null => {
    const v = values[s] && values[s][c];
    return typeof v === 'number' ? v : null;
  };
  const add = (s: number, c: number) => keys.add(s + ':' + c);
  if (mode === 'all') {
    for (let s = 0; s < S; s++) for (let c = 0; c < C; c++) if (num(s, c) != null) add(s, c);
    return keys;
  }
  const wantMax = mode === 'max' || mode === 'maxmin';
  const wantMin = mode === 'min' || mode === 'maxmin';
  for (let s = 0; s < S; s++) {
    let maxC = -1;
    let minC = -1;
    let maxV = -Infinity;
    let minV = Infinity;
    for (let c = 0; c < C; c++) {
      const v = num(s, c);
      if (v == null) continue;
      if (v > maxV) {
        maxV = v;
        maxC = c;
      }
      if (v < minV) {
        minV = v;
        minC = c;
      }
    }
    if (wantMax && maxC >= 0) add(s, maxC);
    if (wantMin && minC >= 0) add(s, minC);
  }
  return keys;
}

/** The ⋯ menu's Copy data for a hexbin or flow map: a table from the reply's own figures. */
export function geoMapTable(data: MapData, kind: 'hexbin' | 'flow'): Pick<MapData, 'labels' | 'series'> {
  const geo = data.geo;
  if (kind === 'flow') {
    const flows = geo?.flow?.flows || [];
    return { labels: flows.map((f) => f.name), series: [{ name: geo?.flow?.label || '', values: flows.map((f) => f.value) }] };
  }
  const items = geo?.items || [];
  return { labels: items.map((i) => i.name), series: [{ name: geo?.hex?.label || '', values: items.map((i) => i.value) }] };
}

/** Labels × series as tab-separated text — what "Copy data" puts on the clipboard. Values unformatted. */
export function dataToTSV(data: Pick<MapData, 'labels' | 'series'>): string {
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const series = Array.isArray(data.series) ? data.series : [];
  const header = ['Label', ...series.map((s) => s.name || '')].join('\t');
  const rows = labels.map((label, i) => [label, ...series.map((s) => (s.values && s.values[i] != null ? s.values[i] : ''))].join('\t'));
  return [header, ...rows].join('\n');
}
