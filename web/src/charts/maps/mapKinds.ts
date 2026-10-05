// WHICH MAP a chart id is, and which map a reply's geo draws — one answer for
// every surface (builder, analysis pane, export, thumbnails). PURE; ported
// from the desktop's mapKinds.ts. Hexbin and flow replies carry `geo.hex` /
// `geo.flow`, which only their own map can draw.

import type { MapGeo } from './types';

export const MAP_CHART_TYPES = ['map_bubble', 'map_choropleth', 'map_hexbin', 'map_flow'] as const;
export type MapChartType = (typeof MAP_CHART_TYPES)[number];

export function isMapChartType(t: string): t is MapChartType {
  return (MAP_CHART_TYPES as readonly string[]).includes(t);
}

/** The map a reply's geo is drawn as by default: its own for hexbin / flow, else a region map. */
export function geoChartTypeFor(geo: MapGeo | null | undefined): MapChartType {
  if (geo && geo.hex) return 'map_hexbin';
  if (geo && geo.flow) return 'map_flow';
  return 'map_choropleth';
}

/** Can map `type` draw this geo at all? A density or route reply fits only its own map. */
export function geoMapFits(type: string, geo: MapGeo | null | undefined): boolean {
  if (!geo) return false;
  if (geo.hex || geo.flow) return type === geoChartTypeFor(geo);
  return type === 'map_bubble' || type === 'map_choropleth';
}

/** The "needs …" line a picker shows for a map this data cannot draw. */
export function geoNeedsText(type: string, hasGeo: boolean): string {
  if (type === 'map_hexbin') return 'latitude and longitude columns (set Map regions to Hexbin density)';
  if (type === 'map_flow') return 'origin and destination coordinates (set Map regions to Flows)';
  return hasGeo ? 'places or regions rather than density or routes' : 'place or region data';
}

/** Charts first, then the map this data draws — or ONLY the map, for density and routes. */
export function withGeoChartType(recommended: string[], geo: MapGeo | null | undefined): string[] {
  if (!geo) return recommended;
  if (geo.hex || geo.flow) return [geoChartTypeFor(geo)];
  return recommended.concat([geoChartTypeFor(geo)]);
}
