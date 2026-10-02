// WHICH MAP a chart id is, and which map a `visual:data` reply's geo draws —
// one answer for every surface that used to spell out 'map_bubble' ||
// 'map_choropleth' (the builder, the analysis pane, the export dialog, the
// report and share paths, the thumbnails). Classic global-scope renderer
// <script>; everything here is read at call time, so load order does not matter.
//
// Depth round 6 adds two: `map_hexbin` (density in hexagons, main-computed at a
// fixed set of zoom levels) and `map_flow` (origin → destination routes). Their
// replies carry `geo.hex` / `geo.flow`, which only they can draw, and the region
// and bubble maps cannot draw those replies either.

const MAP_CHART_TYPES = ['map_bubble', 'map_choropleth', 'map_hexbin', 'map_flow'];

function isMapChartType(t: string): boolean {
  return MAP_CHART_TYPES.indexOf(t) >= 0;
}

/** The map a reply's geo is drawn as by default: its own for hexbin / flow, else a region map. */
function geoChartTypeFor(geo: any): string {
  if (geo && geo.hex) return 'map_hexbin';
  if (geo && geo.flow) return 'map_flow';
  return 'map_choropleth';
}

/** Can map `type` draw this geo at all? A density or route reply fits only its own map. */
function geoMapFits(type: string, geo: any): boolean {
  if (!geo) return false;
  if (geo.hex || geo.flow) return type === geoChartTypeFor(geo);
  return type === 'map_bubble' || type === 'map_choropleth';
}

/** The "needs …" line a picker shows for a map this data cannot draw. */
function geoNeedsText(type: string, hasGeo: boolean): string {
  if (type === 'map_hexbin') return t('mapKinds.latitude_and_longitude_columns_set_map');
  if (type === 'map_flow') return t('mapKinds.origin_and_destination_coordinates_set');
  return hasGeo ? t('mapKinds.places_or_regions_rather_than_density') : t('mapKinds.place_or_region_data');
}

/** Charts first, then the map this data draws — or ONLY the map, for density and routes (they have no labels to chart). */
function withGeoChartType(recommended: string[], geo: any): string[] {
  if (!geo) return recommended;
  if (geo.hex || geo.flow) return [geoChartTypeFor(geo)];
  return recommended.concat([geoChartTypeFor(geo)]);
}
