// Build assets/geo/places.json.gz — the OFFLINE place table a city, county or
// ZIP column is geocoded against. Run by hand (`node scripts/build-places.js`);
// the output is committed, so neither install nor runtime ever touches the
// network for it.
//
// Every source is public domain:
//   Natural Earth 10m populated places — 7,342 world cities (naturalearthdata.com)
//   US Census 2023 Gazetteer — incorporated places, counties, ZCTAs (census.gov)
//
// Cities are Natural Earth by population, then US incorporated places of at
// least 2 sq mi by land area (≈15k in all). ARRAY ORDER IS THE TIE-BREAK: the
// matcher takes the first city of a name, so "Springfield" with no state means
// the most populous one. ZIP3 centroids are the land-weighted mean of their
// ZCTAs' internal points.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

const OUT = path.join(__dirname, '..', 'assets', 'geo', 'places.json.gz');
const CACHE = path.join(os.tmpdir(), 'ordinate-places-src');
const GAZ = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/';
const NE = 'https://naciscdn.org/naturalearth/10m/cultural/ne_10m_populated_places_simple.zip';

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico',
};

async function download(url: string): Promise<Buffer> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, path.basename(url));
  if (fs.existsSync(file)) return fs.readFileSync(file);
  console.log('[places] fetching ' + url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

/** One entry out of a .zip, by suffix. Central directory → local header → inflate. */
function unzipEntry(zip: Buffer, suffix: string): Buffer {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const skip = nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (name.endsWith(suffix)) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(start, start + size);
      return method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    }
    p += 46 + skip;
  }
  throw new Error('no ' + suffix + ' in zip');
}

/** A dBase III table as rows of trimmed strings keyed by field name. */
function readDbf(b: Buffer): Record<string, string>[] {
  const n = b.readUInt32LE(4);
  const headerLen = b.readUInt16LE(8);
  const recLen = b.readUInt16LE(10);
  const fields: { name: string; len: number }[] = [];
  for (let o = 32; b[o] !== 0x0d; o += 32) {
    fields.push({ name: b.toString('latin1', o, o + 11).replace(/\0.*$/, ''), len: b[o + 16] });
  }
  const rows: Record<string, string>[] = [];
  for (let r = 0; r < n; r++) {
    let o = headerLen + r * recLen + 1; // +1: the deletion flag
    const row: Record<string, string> = {};
    for (const f of fields) {
      row[f.name] = b.toString('utf8', o, o + f.len).trim();
      o += f.len;
    }
    rows.push(row);
  }
  return rows;
}

/** Tab-separated Gazetteer text; the header row has trailing spaces. */
function readGaz(buf: Buffer): Record<string, string>[] {
  const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split('\t').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split('\t');
    const row: Record<string, string> = {};
    head.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

// "Birmingham city", "Nashville-Davidson metropolitan government (balance)".
const LSAD_TAIL = /\s+(city and borough|city|town|village|borough|municipality|cdp|corporation|plantation|urban county|(?:consolidated|metropolitan|unified) government)(\s+\(balance\))?$/i;

async function main(): Promise<void> {
  const ne = readDbf(unzipEntry(await download(NE), '.dbf'));
  const places = readGaz(unzipEntry(await download(GAZ + '2023_Gaz_place_national.zip'), '.txt'));
  const counties = readGaz(unzipEntry(await download(GAZ + '2023_Gaz_counties_national.zip'), '.txt'));
  const zctas = readGaz(unzipEntry(await download(GAZ + '2023_Gaz_zcta_national.zip'), '.txt'));

  // [name, admin1, iso2, lat, lon]
  const cities: [string, string, string, number, number][] = [];
  const seen = new Set<string>();
  ne.sort((a, b) => Number(b.pop_max) - Number(a.pop_max));
  for (const c of ne) {
    const iso = c.iso_a2 === '-99' ? '' : c.iso_a2;
    cities.push([c.name, c.adm1name, iso, r3(Number(c.latitude)), r3(Number(c.longitude))]);
    seen.add((c.name + '|' + c.adm1name).toLowerCase());
  }
  const usPlaces = places
    .filter((p) => p.FUNCSTAT === 'A' && Number(p.ALAND_SQMI) >= 2 && US_STATES[p.USPS])
    .sort((a, b) => Number(b.ALAND_SQMI) - Number(a.ALAND_SQMI));
  for (const p of usPlaces) {
    const name = p.NAME.replace(LSAD_TAIL, '');
    const state = US_STATES[p.USPS];
    const key = (name + '|' + state).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cities.push([name, state, 'US', r3(Number(p.INTPTLAT)), r3(Number(p.INTPTLONG))]);
  }

  // [name, state, fips, lat, lon]
  const countyRows = counties
    .filter((c) => US_STATES[c.USPS])
    .map((c) => [c.NAME, US_STATES[c.USPS], c.GEOID, r3(Number(c.INTPTLAT)), r3(Number(c.INTPTLONG))]);

  // [prefix, lat, lon]
  const acc = new Map<string, { w: number; lat: number; lon: number }>();
  for (const z of zctas) {
    const w = Math.max(1, Number(z.ALAND));
    const k = z.GEOID.slice(0, 3);
    const a = acc.get(k) || { w: 0, lat: 0, lon: 0 };
    a.w += w;
    a.lat += w * Number(z.INTPTLAT);
    a.lon += w * Number(z.INTPTLONG);
    acc.set(k, a);
  }
  const zip3 = [...acc.entries()].sort().map(([k, a]) => [k, r3(a.lat / a.w), r3(a.lon / a.w)]);

  const out = {
    v: 1,
    sources: [
      'Natural Earth 10m populated places (public domain)',
      'US Census Bureau 2023 Gazetteer Files (public domain)',
    ],
    cities,
    counties: countyRows,
    zip3,
  };
  const gz = zlib.gzipSync(JSON.stringify(out), { level: 9 });
  fs.writeFileSync(OUT, gz);
  console.log(`[places] ${cities.length} cities, ${countyRows.length} counties, ${zip3.length} ZIP3 → ${OUT} (${(gz.length / 1024).toFixed(0)} KB)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
