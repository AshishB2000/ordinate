// What a map draws: the `data` of a `visual:data` reply (src/ipc/visuals.ts,
// shaped by src/analysis/vizData.ts, mapData.ts and geo/geoAgg.ts). Every
// figure in it was computed on the server; the map only places and colours it.
// Mirrored by hand — the server's types live in the Node world.

export interface GeoItem {
  name: string;
  value: number | null;
  lat?: number;
  lng?: number;
  /** A country's ISO code, when the reply carries one. */
  code?: string;
  /** US sub-state levels: the state and county-vs-city kind that disambiguate a name. */
  state?: string;
  kind?: string;
  /** Point maps: the colour column's value. */
  color?: string | number;
}

export interface HexCell {
  id: string;
  q: number;
  r: number;
  n: number;
  value: number | null;
  lat: number;
  lng: number;
  /** Six corners, flat [lng, lat, …]. */
  ring: number[];
}
export interface HexLevel {
  res: number;
  zoom: number;
  hexes: HexCell[];
}
export interface HexInfo {
  agg: 'count' | 'sum' | 'avg';
  label: string;
  points: number;
  skipped: number;
  maxHexes: number;
  levels: HexLevel[];
  /** Levels the server left out for having more than maxHexes hexagons. */
  dropped: Array<{ res: number; count: number }>;
}

export interface FlowRoute {
  name: string;
  from: string;
  to: string;
  value: number | null;
  n: number;
  o: [number, number];
  d: [number, number];
  /** The arc, flat [lng, lat, …]. */
  path: number[];
}
export interface FlowInfo {
  agg: 'count' | 'sum' | 'avg';
  label: string;
  points: number;
  skipped: number;
  routes: number;
  cap: number;
  flows: FlowRoute[];
}

export interface MapGeo {
  level: string;
  items: GeoItem[];
  /** Items carry their own coordinates (point, city and ZIP levels). */
  points?: boolean;
  hex?: HexInfo;
  flow?: FlowInfo;
  basemap?: 'osm' | 'none';
  boundaryId?: string;
  property?: string;
  colorColumn?: string;
  skipped?: number;
  unmatched?: { count: number; values: string[] };
}

export interface Series {
  name: string;
  values: Array<number | null>;
}

export interface MapData {
  labels: string[];
  series: Series[];
  geo?: MapGeo;
  /** The column a click on a region or point selects (a dashboard action). */
  markColumn?: string;
  dataShape?: string;
}

/** A GeoJSON FeatureCollection as the boundary files and the layers use it. */
export interface Feature {
  type: 'Feature';
  geometry: { type: string; coordinates?: unknown; geometries?: Array<{ coordinates?: unknown }> } | null;
  properties: Record<string, unknown>;
}
export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

/** [west, south, east, north] */
export type BBox = [number, number, number, number];
