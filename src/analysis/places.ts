// OFFLINE place lookup: a city, county or ZIP value → a point. MAIN PROCESS.
//
// The table is assets/geo/places.json.gz (scripts/build-places.ts: Natural
// Earth + US Census Gazetteer, both public domain), gunzipped once on first use.
// Nothing here touches the network.
//
// Matching is by NORMALISED name — case, accents, punctuation and spacing fold
// away — and an optional region after a comma ("Portland, OR", "Portland,
// Oregon", "Cook County, IL"). Without a region the FIRST entry of a name
// wins, and the table is ordered most-populous first, so "Springfield" means
// the largest one. What does not match is counted and listed, never guessed.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export type PlaceLevel = 'us_city' | 'world_city' | 'us_county' | 'us_zip';
export interface PlacePoint { lat: number; lng: number }

interface Table {
  cities: [string, string, string, number, number][];
  counties: [string, string, string, number, number][];
  zip3: [string, number, number][];
}

export const US_STATE_CODES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};

/** Lowercase, accents off, punctuation to spaces, "st." → "saint", spaces collapsed. */
export function normPlace(s: unknown): string {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(st|ste)\b/g, 'saint')
    .replace(/\s+/g, ' ')
    .trim();
}

const COUNTY_TAIL = /\s+(county|parish|borough|census area|city and borough|municipality|municipio)$/;

/** A region qualifier → the full state name, when it is a US state by code or name. */
function stateOf(q: string): string | null {
  const up = q.trim().toUpperCase();
  if (US_STATE_CODES[up]) return normPlace(US_STATE_CODES[up]);
  const n = normPlace(q);
  return Object.values(US_STATE_CODES).some((s) => normPlace(s) === n) ? n : null;
}

let table: Table | null = null;
let index: { city: Map<string, number[]>; county: Map<string, number[]>; zip: Map<string, number> } | null = null;

/** Load (once) and index. `file` is for the self-check; the app reads the bundled table. */
export function loadPlaces(file = path.join(__dirname, '..', '..', 'assets', 'geo', 'places.json.gz')): boolean {
  if (index) return true;
  try {
    table = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as Table;
  } catch (_) {
    return false;
  }
  const city = new Map<string, number[]>();
  table.cities.forEach((c, i) => {
    const k = normPlace(c[0]);
    city.set(k, [...(city.get(k) || []), i]);
  });
  const county = new Map<string, number[]>();
  table.counties.forEach((c, i) => {
    const k = normPlace(c[0]).replace(COUNTY_TAIL, '');
    county.set(k, [...(county.get(k) || []), i]);
  });
  const zip = new Map<string, number>();
  table.zip3.forEach((z, i) => zip.set(z[0], i));
  index = { city, county, zip };
  return true;
}

/** The ZIP3 a value names: "02134", "2134" (a number that lost its zero), "02134-1234". */
export function zip3Of(v: unknown): string | null {
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{3,5})(?:-\d{4})?$/.exec(s);
  if (!m) return null;
  const five = m[1].padStart(5, '0');
  return five.slice(0, 3);
}

/** One value → a point, or null. */
export function matchPlace(value: unknown, level: PlaceLevel): PlacePoint | null {
  if (!loadPlaces() || !table || !index) return null;
  if (level === 'us_zip') {
    const z = zip3Of(value);
    const i = z === null ? undefined : index.zip.get(z);
    return i === undefined ? null : { lat: table.zip3[i][1], lng: table.zip3[i][2] };
  }
  const raw = String(value == null ? '' : value);
  const comma = raw.lastIndexOf(',');
  let name = comma > 0 ? raw.slice(0, comma) : raw;
  let region = comma > 0 ? raw.slice(comma + 1) : '';
  // "Austin TX" — a trailing state code with no comma.
  const tail = /^(.*\S)\s+([A-Za-z]{2})$/.exec(raw.trim());
  if (!region && tail && US_STATE_CODES[tail[2].toUpperCase()]) { name = tail[1]; region = tail[2]; }
  const wantState = region ? stateOf(region) : null;
  const wantRegion = region ? normPlace(region) : '';

  if (level === 'us_county') {
    const ids = index.county.get(normPlace(name).replace(COUNTY_TAIL, '')) || [];
    const hit = ids.find((i) => !wantState || normPlace(table!.counties[i][1]) === wantState);
    return hit === undefined ? null : { lat: table.counties[hit][3], lng: table.counties[hit][4] };
  }
  const ids = index.city.get(normPlace(name)) || [];
  const hit = ids.find((i) => {
    const c = table!.cities[i];
    if (level === 'us_city' && c[2] !== 'US') return false;
    if (!region) return true;
    const admin = normPlace(c[1]);
    return (wantState !== null && admin === wantState) || admin === wantRegion || normPlace(c[2]) === wantRegion;
  });
  return hit === undefined ? null : { lat: table.cities[hit][3], lng: table.cities[hit][4] };
}

/** Many values: the matched points by value, and what did not match (counted, first `list` named). */
export function matchPlaces(values: unknown[], level: PlaceLevel, list = 12): {
  points: Map<string, PlacePoint>;
  unmatched: { count: number; values: string[] };
} {
  const points = new Map<string, PlacePoint>();
  const missed = new Set<string>();
  for (const v of values) {
    const key = String(v == null ? '' : v);
    if (points.has(key) || missed.has(key)) continue;
    const p = matchPlace(v, level);
    if (p) points.set(key, p);
    else missed.add(key);
  }
  return { points, unmatched: { count: missed.size, values: [...missed].slice(0, list) } };
}
