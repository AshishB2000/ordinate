// Static mini-maps for gallery cards — renderer/hub/mapThumb.ts and
// mapGeoThumb.ts: the boundary polygons (or the server's hexagons and arcs)
// projected onto a plain 2D canvas. No MapLibre, no WebGL, no tiles: a shape,
// not a map — so it draws anywhere a 2D context does.
//
// `mapThumbProject` / `mapThumbFills` are PURE (geo.test.ts runs them against
// the desktop's); the draw functions take the theme as values.

import { choroplethColor, unit } from './colors';
import { extendBBox, geoBBox, hasCoords, withCentroids } from './geometry';
import { matchGeoItem } from './geoMatch';
import type { BBox, Feature, GeoItem, MapGeo } from './types';

export const MAP_THUMB_PAD = 2;
const BUBBLE_R: readonly [number, number] = [2, 9];
const GEO_THUMB_MAX_HEXES = 600;

/**
 * lng/lat → canvas px, fitting `bbox` into width × height with `pad` inset and
 * the aspect kept. Equirectangular at the bbox's mid-latitude (longitudes ×
 * cos(midLat)), which stops the US looking 30% too wide.
 */
export function mapThumbProject(bbox: BBox, width: number, height: number, pad: number): (lng: number, lat: number) => [number, number] {
  const [w, s, e, n] = bbox;
  const kx = Math.cos((((s + n) / 2) * Math.PI) / 180) || 1;
  const dx = Math.max(1e-9, (e - w) * kx);
  const dy = Math.max(1e-9, n - s);
  const bw = Math.max(1, width - pad * 2);
  const bh = Math.max(1, height - pad * 2);
  const scale = Math.min(bw / dx, bh / dy);
  const ox = pad + (bw - dx * scale) / 2;
  const oy = pad + (bh - dy * scale) / 2;
  return (lng, lat) => [ox + (lng - w) * kx * scale, oy + (n - lat) * scale];
}

/** One fill per feature, in order: matched regions on the live map's scale, the rest `emptyFill`. */
export function mapThumbFills(features: readonly Feature[], items: readonly GeoItem[], emptyFill: string, colorFor: (t: number) => string): string[] {
  const vs = (items || []).map((i) => i && i.value).filter((v): v is number => typeof v === 'number');
  const min = vs.length ? Math.min(...vs) : 0;
  const max = vs.length ? Math.max(...vs) : 1;
  return (features || []).map((f) => {
    const item = matchGeoItem(items || [], (f && f.properties) || {});
    if (!item || typeof item.value !== 'number') return emptyFill;
    return colorFor(unit(item.value, min, max));
  });
}

function rings(geometry: Feature['geometry']): number[][][] {
  if (!geometry) return [];
  const c = geometry.coordinates as number[][][] | number[][][][] | undefined;
  if (geometry.type === 'Polygon') return (c as number[][][]) || [];
  if (geometry.type === 'MultiPolygon') return ((c as number[][][][]) || []).flat();
  return [];
}

function trace(ctx: CanvasRenderingContext2D, rs: number[][][], project: (lng: number, lat: number) => [number, number]): void {
  ctx.beginPath();
  for (const ring of rs) {
    for (let i = 0; i < ring.length; i += 1) {
      const p = project(ring[i][0], ring[i][1]);
      if (i === 0) ctx.moveTo(p[0], p[1]);
      else ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
  }
}

export interface ThumbTheme {
  empty: string;
  line: string;
  accent: string;
  dark: boolean;
}

/** A region (or bubble) thumbnail over a level's boundaries. False when there is nothing to draw. */
export function drawRegionThumb(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  geo: MapGeo,
  features: readonly Feature[],
  bubble: boolean,
  theme: ThumbTheme,
): boolean {
  if (!geo.items.length || !features.length) return false;
  const bboxes = features.map((f) => geoBBox(f && f.geometry));
  // '' marks "no data", so the fit can tell a matched region from one that merely shares the empty colour.
  const raw = mapThumbFills(features, geo.items, '', (t) => choroplethColor(t, theme.dark));
  const fills = bubble ? features.map(() => theme.empty) : raw.map((c) => c || theme.empty);
  // Fit the MATCHED regions, as the live map does; nothing matched → the whole level.
  let fit: BBox | null = null;
  raw.forEach((c, i) => {
    if (c) fit = extendBBox(fit, bboxes[i]);
  });
  let all: BBox | null = null;
  for (const b of bboxes) all = extendBBox(all, b);
  if (!fit && !all) return false;
  const project = mapThumbProject((fit || all) as BBox, w, h, MAP_THUMB_PAD);
  ctx.lineWidth = 0.4;
  ctx.strokeStyle = theme.line;
  features.forEach((f, i) => {
    const rs = rings(f && f.geometry);
    if (!rs.length) return;
    trace(ctx, rs, project);
    ctx.fillStyle = fills[i];
    ctx.fill('evenodd');
    ctx.stroke();
  });
  if (bubble) {
    // A bubble map is points: circles at each item's coordinates, or its region's centroid.
    const placed = withCentroids(geo.items, features).filter((i) => hasCoords(i) && typeof i.value === 'number');
    if (placed.length) {
      const vs = placed.map((i) => i.value as number);
      const min = Math.min(...vs);
      const max = Math.max(...vs);
      ctx.fillStyle = theme.accent;
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 0.75;
      ctx.globalAlpha = 0.55;
      for (const item of placed) {
        const p = project(item.lng as number, item.lat as number);
        ctx.beginPath();
        ctx.arc(p[0], p[1], BUBBLE_R[0] + unit(item.value as number, min, max) * (BUBBLE_R[1] - BUBBLE_R[0]), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
  return true;
}

/** A hexbin or flow thumbnail: the same hexagons and arcs the server computed, over faint world land. */
export function drawGeoThumb(ctx: CanvasRenderingContext2D, w: number, h: number, geo: MapGeo, world: readonly Feature[], theme: ThumbTheme): boolean {
  const levels = geo.hex ? geo.hex.levels : [];
  // The finest level that still reads at thumbnail size.
  const level = [...levels].reverse().find((l) => l.hexes.length <= GEO_THUMB_MAX_HEXES) || levels[0] || null;
  const flows = geo.flow ? geo.flow.flows : [];
  let bbox: BBox | null = null;
  const grow = (lng: number, lat: number): void => {
    bbox = extendBBox(bbox, [lng, lat, lng, lat]);
  };
  if (level) for (const x of level.hexes) for (let i = 0; i < x.ring.length; i += 2) grow(x.ring[i], x.ring[i + 1]);
  for (const f of flows) for (let i = 0; i < f.path.length; i += 2) grow(f.path[i], f.path[i + 1]);
  if (!bbox) return false;
  const [x0, y0, x1, y1] = bbox as BBox;
  const padX = Math.max(0.5, (x1 - x0) * 0.15);
  const padY = Math.max(0.5, (y1 - y0) * 0.15);
  const project = mapThumbProject([x0 - padX, y0 - padY, x1 + padX, y1 + padY], w, h, MAP_THUMB_PAD);

  ctx.fillStyle = theme.empty;
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = 0.4;
  for (const f of world) {
    const rs = rings(f && f.geometry);
    if (!rs.length) continue;
    trace(ctx, rs, project);
    ctx.fill('evenodd');
    ctx.stroke();
  }
  if (level) {
    const vals = level.hexes.map((x) => x.value).filter((v): v is number => typeof v === 'number');
    const min = vals.length ? Math.min(...vals) : 0;
    const max = vals.length ? Math.max(...vals) : 1;
    for (const x of level.hexes) {
      if (typeof x.value !== 'number') continue;
      const ring: number[][] = [];
      for (let i = 0; i < x.ring.length; i += 2) ring.push([x.ring[i], x.ring[i + 1]]);
      trace(ctx, [ring], project);
      ctx.fillStyle = choroplethColor(unit(x.value, min, max), theme.dark);
      ctx.fill();
    }
  }
  if (flows.length) {
    const max = Math.max(0, ...flows.map((f) => (typeof f.value === 'number' ? f.value : 0)));
    ctx.strokeStyle = theme.accent;
    ctx.globalAlpha = 0.6;
    ctx.lineCap = 'round';
    for (const f of flows) {
      ctx.lineWidth = 0.6 + (max > 0 && typeof f.value === 'number' && f.value > 0 ? Math.sqrt(f.value / max) * 2.4 : 0);
      ctx.beginPath();
      for (let i = 0; i < f.path.length; i += 2) {
        const p = project(f.path[i], f.path[i + 1]);
        if (i === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  return true;
}
