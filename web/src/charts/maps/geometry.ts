// Map geometry and labelling — the pure helpers of the desktop's mapRender.ts:
// bounding boxes (MapLibre has no getBounds for a GeoJSON geometry), region
// abbreviations, the per-period values of a time-series map, and bubble homes
// at region centroids. PURE; geo.test.ts runs each against the desktop's.

import { matchGeoItem, normalizeName } from './geoMatch';
import type { BBox, Feature, GeoItem, Series } from './types';

export function geoBBox(geometry: Feature['geometry'] | undefined): BBox | null {
  if (!geometry) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords) || coords.length === 0) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const lng = coords[0];
      const lat = coords[1];
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      return;
    }
    for (const c of coords) walk(c);
  };
  if (Array.isArray(geometry.geometries)) geometry.geometries.forEach((g) => walk(g && g.coordinates));
  else walk(geometry.coordinates);
  return Number.isFinite(w) && Number.isFinite(s) ? [w, s, e, n] : null;
}

export function extendBBox(a: BBox | null, b: BBox | null): BBox | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function bboxCenter(b: BBox): { lat: number; lng: number } {
  return { lng: (b[0] + b[2]) / 2, lat: (b[1] + b[3]) / 2 };
}

// ponytail: the bundled us-states GeoJSON carries only a name, so this small
// lookup labels states "CA". Keyed by normalizeName() output.
const US_STATE_ABBR: Readonly<Record<string, string>> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC', 'puerto rico': 'PR',
};

/** Short label for a region: USPS code for US states, iso2 for countries, else the name. */
export function abbrevFor(item: Pick<GeoItem, 'name' | 'code'>, featProps: Record<string, unknown> | null | undefined, level: string): string {
  const props = featProps || {};
  const propName = typeof props.name === 'string' ? props.name : '';
  if (level === 'us_state') {
    return US_STATE_ABBR[normalizeName(item.name)] || US_STATE_ABBR[normalizeName(propName)] || (item.name || '').slice(0, 3).toUpperCase();
  }
  if (level === 'country') {
    return String(props.iso2 || item.code || (item.name || '').slice(0, 2)).toUpperCase();
  }
  return item.name || propName || '';
}

export interface PeriodGeo {
  periods: string[];
  itemsForPeriod(idx: number): GeoItem[];
  /** The GLOBAL range across every period, for one fixed colour scale. */
  minVal: number;
  maxVal: number;
}

/**
 * A time-series map: labels are region names, one series per period. Each
 * period's items are geo.items with the value swapped for that period's (the
 * static value where a region is not in the labels).
 */
export function buildPeriodGeo(labels: readonly unknown[], series: readonly Series[], geoItems: readonly GeoItem[]): PeriodGeo {
  const idxByName = new Map<string, number>();
  (labels || []).forEach((lab, i) => idxByName.set(normalizeName(String(lab)), i));
  const periods = (series || []).map((s) => (s && s.name) || '');
  const perItem = geoItems.map((item) => {
    const i = idxByName.get(normalizeName(item.name));
    if (i === undefined) return null;
    return series.map((s) => (Array.isArray(s.values) && typeof s.values[i] === 'number' ? s.values[i] : null));
  });
  let minVal = Infinity;
  let maxVal = -Infinity;
  perItem.forEach((arr) => {
    if (arr)
      arr.forEach((v) => {
        if (typeof v === 'number') {
          if (v < minVal) minVal = v;
          if (v > maxVal) maxVal = v;
        }
      });
  });
  if (!Number.isFinite(minVal)) {
    const sv = geoItems.map((i) => i.value).filter((v): v is number => typeof v === 'number');
    minVal = sv.length ? Math.min(...sv) : 0;
    maxVal = sv.length ? Math.max(...sv) : 1;
  }
  const itemsForPeriod = (idx: number): GeoItem[] =>
    geoItems.map((item, k) => {
      const arr = perItem[k];
      const v = arr && typeof arr[idx] === 'number' ? arr[idx] : item.value;
      return { ...item, value: v };
    });
  return { periods, itemsForPeriod, minVal, maxVal };
}

/**
 * Bubble homes for named regions: each item without coordinates goes to its
 * matched boundary's bounding-box centre. Returns NEW items (the reply belongs
 * to the query cache); items with coordinates, or no boundary, are unchanged.
 */
export function withCentroids(items: readonly GeoItem[], features: readonly Feature[] | null | undefined): GeoItem[] {
  const out = items.map((i) => ({ ...i }));
  for (const feat of features || []) {
    const item = matchGeoItem(out, (feat && feat.properties) || {});
    if (!item || (typeof item.lat === 'number' && typeof item.lng === 'number')) continue;
    const bb = geoBBox(feat && feat.geometry);
    if (!bb) continue;
    const c = bboxCenter(bb);
    item.lat = c.lat;
    item.lng = c.lng;
  }
  return out;
}

export const hasCoords = (i: GeoItem): i is GeoItem & { lat: number; lng: number } => typeof i.lat === 'number' && typeof i.lng === 'number';
