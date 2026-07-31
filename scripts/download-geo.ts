// Download simplified GeoJSON boundary data for map visualizations.
// Saves world countries and US states as JS globals into assets/geo/.
// Run: node scripts/download-geo.js
// Automatically run via npm postinstall.

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const OUT_DIR = path.join(__dirname, '..', 'assets', 'geo');
const COORD_DECIMALS = 2; // ~1km precision — fine for screen-size maps

// Normalize country names from dataset conventions to common English names
const COUNTRY_NAME_FIXES: Record<string, string> = {
  'USA': 'United States',
  'United States of America': 'United States',
  'Russian Federation': 'Russia',
  'Korea, Republic of': 'South Korea',
  'Korea, Democratic People\'s Republic of': 'North Korea',
  'Iran, Islamic Republic of': 'Iran',
  'Syrian Arab Republic': 'Syria',
  'Viet Nam': 'Vietnam',
  'Lao PDR': 'Laos',
  'Tanzania, United Republic of': 'Tanzania',
  'Congo, Democratic Republic of the': 'Democratic Republic of the Congo',
  'Congo, Republic of the': 'Republic of the Congo',
  'Bolivia, Plurinational State of': 'Bolivia',
  'Venezuela, Bolivarian Republic of': 'Venezuela',
  'Czech Republic': 'Czechia',
  'Macedonia, the former Yugoslav Republic of': 'North Macedonia',
  'Moldova, Republic of': 'Moldova',
  'Brunei Darussalam': 'Brunei',
  'Timor-Leste': 'East Timor',
  'Cabo Verde': 'Cape Verde',
};

interface GeoSource {
  name: string;
  url: string;
  // ponytail: GeoJSON feature envelopes — any in, plain props object out
  pickProps: (feat: any) => Record<string, string>;
  varName?: string;
  json?: boolean;
  coordDecimals?: number;
}

const SOURCES: GeoSource[] = [
  {
    name: 'world-countries',
    // Natural Earth 110m — very simplified, ~400KB, public domain
    url: 'https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson',
    pickProps: feat => {
      const rawName = feat.properties.name || feat.properties.NAME || feat.properties.ADMIN || '';
      const name = COUNTRY_NAME_FIXES[rawName] || rawName;
      return { name, iso2: feat.properties.ISO_A2 || feat.properties.iso2 || '' };
    },
    varName: '__GEO_WORLD__',
  },
  {
    name: 'us-states',
    // PublicaMundi simplified US states — public domain
    url: 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json',
    pickProps: feat => ({
      name: feat.properties.name || feat.properties.NAME || '',
    }),
    varName: '__GEO_US_STATES__',
  },
  {
    name: 'us-counties',
    // plotly public dataset — ~3,200 US counties with FIPS. props: NAME (county,
    // no suffix), STATE (state FIPS code). Written as plain JSON (lazy-loaded via
    // IPC), not a window global, because the file is multi-MB.
    url: 'https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json',
    json: true,
    pickProps: feat => ({
      name: feat.properties.NAME || '',
      state: STATE_FIPS[feat.properties.STATE] || '',
      // LSAD distinguishes a county from a county-equivalent independent city
      // (e.g. VA has both "Roanoke" County and "Roanoke" city).
      kind: /city/i.test(feat.properties.LSAD || '') ? 'city' : 'county',
      fips: feat.id || feat.properties.GEO_ID || '',
    }),
  },
];

// State FIPS code → full state name (for the county source, which only carries FIPS).
const STATE_FIPS: Record<string, string> = {
  '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas',
  '06': 'California', '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware',
  '11': 'District of Columbia', '12': 'Florida', '13': 'Georgia', '15': 'Hawaii',
  '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa', '20': 'Kansas',
  '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine', '24': 'Maryland',
  '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota', '28': 'Mississippi',
  '29': 'Missouri', '30': 'Montana', '31': 'Nebraska', '32': 'Nevada',
  '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico', '36': 'New York',
  '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio', '40': 'Oklahoma',
  '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island', '45': 'South Carolina',
  '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas', '49': 'Utah', '50': 'Vermont',
  '51': 'Virginia', '53': 'Washington', '54': 'West Virginia', '55': 'Wisconsin',
  '56': 'Wyoming', '72': 'Puerto Rico',
};

function fetch(url: string, redirects?: number): Promise<string> {
  if ((redirects || 0) > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'screenchart-geo-setup' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetch(res.headers.location!, (redirects || 0) + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      const stream: NodeJS.ReadableStream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip())
        : res;
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    }).on('error', reject);
  });
}

// Round all coordinate values to COORD_DECIMALS decimal places.
// This alone cuts file size by ~60% for high-res sources.
// ponytail: GeoJSON geometry unions aren't worth modeling here — any in/out
function roundCoords(geom: any, decimals?: number): any {
  if (!geom) return geom;
  const d = typeof decimals === 'number' ? decimals : COORD_DECIMALS;
  const r = (n: number) => Math.round(n * 10 ** d) / 10 ** d;
  const rPair = (p: number[]) => [r(p[0]), r(p[1])];
  const rRing = (ring: number[][]) => ring.map(rPair);
  switch (geom.type) {
    case 'Polygon':
      return { type: 'Polygon', coordinates: geom.coordinates.map(rRing) };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: geom.coordinates.map((poly: number[][][]) => poly.map(rRing)) };
    case 'Point':
      return { type: 'Point', coordinates: rPair(geom.coordinates) };
    default:
      return geom;
  }
}

async function processSource(src: GeoSource): Promise<void> {
  console.log(`Downloading ${src.name}…`);
  let raw: string;
  try {
    raw = await fetch(src.url);
  } catch (err) {
    console.warn(`  Warning: could not download ${src.name}: ${(err as Error).message}`);
    console.warn(`  Map regions won't be placeable until this is fixed.`);
    // Write empty placeholder so the app loads without errors
    const placeholder = `window.${src.varName} = {"type":"FeatureCollection","features":[]};\n`;
    fs.writeFileSync(path.join(OUT_DIR, src.name + '.js'), placeholder, 'utf8');
    return;
  }

  // ponytail: raw GeoJSON envelope
  let geojson: any;
  try {
    geojson = JSON.parse(raw);
  } catch (err) {
    console.warn(`  Warning: could not parse ${src.name}: ${(err as Error).message}`);
    return;
  }

  const stripped = {
    type: 'FeatureCollection',
    features: (geojson.features || [])
      .map((feat: any) => ({
        type: 'Feature',
        properties: src.pickProps(feat),
        geometry: roundCoords(feat.geometry, src.coordDecimals),
      }))
      .filter((f: any) => f.properties.name && f.geometry),
  };

  // Lazy sources (json:true) write a plain .json file loaded on demand via IPC;
  // small eager sources write a .js file that sets a window global.
  let outName: string, contents: string;
  if (src.json) {
    outName = src.name + '.json';
    contents = JSON.stringify(stripped);
  } else {
    outName = src.name + '.js';
    contents = `/* Auto-generated by scripts/download-geo.js — public domain data */\n` +
      `window.${src.varName} = ${JSON.stringify(stripped)};\n`;
  }

  const outPath = path.join(OUT_DIR, outName);
  fs.writeFileSync(outPath, contents, 'utf8');
  const kb = Math.round(contents.length / 1024);
  console.log(`  Saved ${outName} (${kb} KB, ${stripped.features.length} features)`);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const src of SOURCES) {
    await processSource(src);
  }
  console.log('Geo data ready.');
})();
