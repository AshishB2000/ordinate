// DIFFERENTIAL self-check for the hexbin and flow maps: the SHIPPED
// `visual:data` answer (src/ipc/geoViz.ts `geoVizReply`) computed resident —
// DuckDB over the stored Parquet (engine/geoResident.ts) — against the SAME
// function with the resident source withheld, which answers through the JS
// reference (analysis/geo/geoAgg.ts). Every leaf of the two replies — hex ids,
// point counts, sums, averages, rings, route order — is compared with Object.is.
//
// `datasets.getDataset` is spied: the resident answer must never hydrate the
// table, or the fast path could stop firing and this suite would stay green.
// Measures are integer-valued: float summation order is the documented
// resident-layer divergence, and exactness is what is being tested here.
//
//   npm run build:ts && node scripts/test-geoAgg.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-geoagg-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const geoViz: typeof import('../src/ipc/geoViz') = require('../src/ipc/geoViz');
const hexgrid: typeof import('../src/analysis/geo/hexgrid') = require('../src/analysis/geo/hexgrid');
const { sanitizeEncoding } = require('../src/analysis/visuals') as typeof import('../src/analysis/visuals');

type Cell = import('../src/data/transforms').Cell;
type FilterStep = import('../src/data/transforms').FilterStep;

let seed = 5;
const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const CITIES: Array<[string, number, number]> = [
  ['Austin', 30.2672, -97.7431], ['Dallas', 32.7767, -96.797], ['Houston', 29.7604, -95.3698], ['Denver', 39.7392, -104.9903],
];

function fixtureRows(): Cell[][] {
  const rows: Cell[][] = [];
  for (let i = 0; i < 3000; i += 1) {
    const [name, la, lo] = CITIES[i % 4];
    const [dname, dla, dlo] = CITIES[(i * 7 + 1) % 4];
    const lat = la + (rand() - 0.5) * 0.6;
    const lng = lo + (rand() - 0.5) * 0.6;
    const amount = i % 13 === 0 ? null : Math.floor(rand() * 900) + 1;
    rows.push([i, lat, lng, amount, name, dla, dlo, dname, i % 2 ? 'web' : 'store', la, lo]);
  }
  // Rows no map can place: empty, out of range, beyond the Mercator limit.
  rows.push([3000, null, -97, 5, 'x', 30, -97, 'y', 'web', null, -97], [3001, 91, -97, 5, 'x', 30, -97, 'y', 'web', 91, -97],
    [3002, 86, -97, 5, 'x', 30, -97, 'y', 'web', 30, -97], [3003, 30, -181, 5, 'x', 30, -97, 'y', 'web', 30, -181]);
  // A route whose ends share a first-seen tie, and a BOM-led name.
  rows.push([3004, 30.2672, -97.7431, 7, '\uFEFFBOM city', 30.2672, -97.7431, 'Same', 'web', 30.2672, -97.7431]);
  return rows;
}

const COLS = [
  { name: 'id', type: 'number' as const }, { name: 'lat', type: 'number' as const }, { name: 'lng', type: 'number' as const },
  { name: 'amount', type: 'number' as const }, { name: 'origin', type: 'text' as const },
  { name: 'dlat', type: 'number' as const }, { name: 'dlng', type: 'number' as const }, { name: 'dest', type: 'text' as const },
  { name: 'channel', type: 'text' as const },
  // The origin as the exact city point, so routes repeat (lat/lng are jittered for density).
  { name: 'olat', type: 'number' as const }, { name: 'olng', type: 'number' as const },
];

/** The first path where two replies differ under Object.is, or ''. */
function firstDiff(a: unknown, b: unknown, at = '$'): string {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${at} (length ${Array.isArray(a) ? a.length : typeof a} vs ${Array.isArray(b) ? b.length : typeof b})`;
    for (let i = 0; i < a.length; i += 1) { const d = firstDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join() !== kb.join()) return `${at} keys ${ka.join()} vs ${kb.join()}`;
    for (const k of ka) { const d = firstDiff((a as any)[k], (b as any)[k], `${at}.${k}`); if (d) return d; } // any: walking two JSON trees
    return '';
  }
  return Object.is(a, b) ? '' : `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

let hydrations = 0;
const realGetDataset = datasets.getDataset;
const realResident = datasets.residentSource;

async function both(projectId: string, datasetId: string, encoding: unknown, filters: FilterStep[]): Promise<{ fast: any; ref: any; hydrated: number }> { // any: visual:data envelopes
  const enc = sanitizeEncoding(encoding);
  hydrations = 0;
  const fast = await geoViz.geoVizReply(projectId, datasetId, enc, filters);
  const hydrated = hydrations;
  (datasets as any).residentSource = async () => null; // any: withholding the fast path for the reference run
  try {
    const ref = await geoViz.geoVizReply(projectId, datasetId, enc, filters);
    return { fast, ref, hydrated };
  } finally {
    (datasets as any).residentSource = realResident; // any: restoring the module export
  }
}

async function diff(label: string, projectId: string, datasetId: string, encoding: unknown, filters: FilterStep[] = []): Promise<any> { // any: the reply, for follow-up checks
  const { fast, ref, hydrated } = await both(projectId, datasetId, encoding, filters);
  ok(`${label}: both answered`, !!fast && fast.ok && !!ref && ref.ok, JSON.stringify(fast && fast.error) + ' / ' + JSON.stringify(ref && ref.error));
  if (!fast || !ref) return null;
  const d = firstDiff(fast, ref);
  ok(`${label}: resident === JS reference, leaf for leaf (Object.is)`, d === '', d);
  ok(`${label}: the resident answer never hydrated the table`, hydrated === 0, `${hydrated} getDataset call(s)`);
  return fast;
}

async function main(): Promise<void> {
  if (!parquetStore.isSupported()) {
    console.error('FAIL geoAgg: DuckDB bridge unavailable — nothing was verified');
    process.exitCode = 1;
    return;
  }
  (datasets as any).getDataset = async (...a: any[]) => { hydrations += 1; return (realGetDataset as any)(...a); }; // any: the spy wraps the real export
  await projects.init();
  await datasets.init();
  const proj = await projects.createProject('Geo agg');
  const ds = await datasets.saveDataset(proj.id, { name: 'points', sourceKind: 'csv', columns: COLS, rows: fixtureRows() });
  if (!ds) throw new Error('saveDataset failed');
  ok('fixture is resident', (await datasets.residentSource(proj.id, ds.id)) !== null);

  const hexEnc = (agg: string, col = 'amount'): unknown => ({
    category: 'origin', values: [{ column: col, aggregation: agg }], geo: { level: 'hexbin', lat: 'lat', lon: 'lng' },
  });
  const count = await diff('hexbin count', proj.id, ds.id, hexEnc('count'));
  if (count) {
    const h = count.data.geo.hex;
    ok('hexbin: every usable row counted once per level', h.levels.every((l: any) => l.hexes.reduce((a: number, x: any) => a + x.n, 0) === h.points) && h.points === 3001, h.points); // any: reply JSON
    ok('hexbin: 4 unplaceable rows skipped (empty, |lat| > 90, beyond the Mercator limit, |lng| > 180)', h.skipped === 4, h.skipped);
    ok('hexbin: hex ids are "res:q:r" and sorted by (q, r)', h.levels.every((l: any) => l.hexes.every((x: any, i: number, arr: any[]) => // any: reply JSON
      x.id === `${l.res}:${x.q}:${x.r}` && (i === 0 || arr[i - 1].q < x.q || (arr[i - 1].q === x.q && arr[i - 1].r < x.r)))));
    ok('hexbin: every level is the fixed set, capped at MAX_HEXES', h.levels.length + h.dropped.length === hexgrid.HEX_LEVELS
      && h.levels.every((l: any) => l.hexes.length <= hexgrid.MAX_HEXES)); // any: reply JSON
  }
  await diff('hexbin sum', proj.id, ds.id, hexEnc('sum'));
  const avg = await diff('hexbin avg', proj.id, ds.id, hexEnc('avg'));
  if (avg) ok('hexbin avg: a hexagon of empty measures shows null, never 0', avg.data.geo.hex.levels.every((l: any) => l.hexes.every((x: any) => x.value === null || x.value > 0))); // any: reply JSON
  await diff('hexbin with a value filter', proj.id, ds.id, hexEnc('sum'), [{ type: 'filter', column: 'channel', op: '=', value: 'web' }]);
  await diff('hexbin within 40 km of Austin', proj.id, ds.id, hexEnc('count'),
    [{ type: 'filter', column: 'lat', op: 'within_km', radius: { lngColumn: 'lng', lat: 30.2672, lng: -97.7431, km: 40 } }]);
  {
    const minmax = await diff('hexbin with a max measure (shown as the sum, with a note)', proj.id, ds.id, hexEnc('max'));
    ok('…says so', !!minmax && minmax.warnings.some((w: string) => /showing the sum/.test(w)));
  }

  const flowEnc = (agg: string, names = true): unknown => ({
    category: 'origin', values: [{ column: 'amount', aggregation: agg }],
    geo: { level: 'flow', lat: 'olat', lon: 'olng', lat2: 'dlat', lon2: 'dlng', ...(names ? { from: 'origin', to: 'dest' } : {}) },
  });
  const flows = await diff('flows count', proj.id, ds.id, flowEnc('count'));
  if (flows) {
    const f = flows.data.geo.flow;
    ok('flows: every route counted, value-descending', f.routes === 6 && f.routes === f.flows.length && f.flows.every((x: any, i: number, a: any[]) => i === 0 || a[i - 1].value >= x.value), f.routes); // any: reply JSON
    ok('flows: named by the first stored row\'s origin and destination', f.flows.some((x: any) => x.name === '\uFEFFBOM city → Same'), JSON.stringify(f.flows.map((x: any) => x.name))); // any: reply JSON
  }
  await diff('flows sum', proj.id, ds.id, flowEnc('sum'));
  await diff('flows avg, unnamed (coordinates as names)', proj.id, ds.id, flowEnc('avg', false));
  await diff('flows with a filter', proj.id, ds.id, flowEnc('sum'), [{ type: 'filter', column: 'amount', op: '>', value: 400 }]);

  // The cap: many distinct routes → the top FLOW_CAP by value, ties by first row.
  {
    const rows: Cell[][] = [];
    for (let i = 0; i < 1400; i += 1) rows.push([i, 0, 0, (i % 5) + 1, 'o', 40, -100 + (i % 2), 'd', 'web', 30 + i / 1000, -97]);
    const many = await datasets.saveDataset(proj.id, { name: 'many', sourceKind: 'csv', columns: COLS, rows });
    if (many) {
      const r = await diff('flows over the cap', proj.id, many.id, flowEnc('sum'));
      if (r) ok('flows over the cap: 500 of 1,400 routes drawn, and the count says so', r.data.geo.flow.flows.length === 500 && r.data.geo.flow.routes === 1400, r.data.geo.flow.routes);
    }
    // Spread points: the finest levels exceed MAX_HEXES and are dropped by BOTH engines.
    const spread: Cell[][] = [];
    for (let i = 0; i < 20000; i += 1) spread.push([i, -60 + rand() * 120, -170 + rand() * 340, 1, 'o', 0, 0, 'd', 'web', 0, 0]);
    const wide = await datasets.saveDataset(proj.id, { name: 'wide', sourceKind: 'csv', columns: COLS, rows: spread });
    if (wide) {
      const r = await diff('hexbin with levels over the cap', proj.id, wide.id, hexEnc('count'));
      if (r) ok('…the fine levels are dropped and counted', r.data.geo.hex.dropped.length > 0 && r.data.geo.hex.dropped.every((d: any) => d.count > hexgrid.MAX_HEXES)); // any: reply JSON
    }
  }

  // The published page's whitelist: one hex level, figures and geometry only.
  {
    const sanitize: typeof import('../src/publish/sanitize') = require('../src/publish/sanitize');
    const hexReply = await geoViz.geoVizReply(proj.id, ds.id, sanitizeEncoding(hexEnc('sum')), []);
    const pub: any = sanitize.sanitizePayload({ ...hexReply.data, geo: { ...hexReply.data.geo, secret: 'x' } }); // any: the whitelisted JSON
    const lv = pub.geo.hex.levels;
    ok('publish: a hexbin carries ONE level, within 1,500 hexagons', lv.length === 1 && lv[0].hexes.length <= 1500 && lv[0].hexes.length > 0);
    ok('publish: hexagons keep their figures and six corners, nothing else', lv[0].hexes.every((h: any) => h.ring.length === 12
      && Object.keys(h).sort().join() === 'lat,lng,n,ring,value') && !('secret' in pub.geo)); // any: whitelisted JSON
    const flowReply = await geoViz.geoVizReply(proj.id, ds.id, sanitizeEncoding(flowEnc('sum')), []);
    const pf: any = sanitize.sanitizePayload(flowReply.data); // any: the whitelisted JSON
    ok('publish: routes keep names, figures and arcs', pf.geo.flow.flows.length === flowReply.data.geo.flow.flows.length
      && pf.geo.flow.flows.every((f: any, i: number) => Object.is(f.value, flowReply.data.geo.flow.flows[i].value) && f.path.length === 50)); // any: whitelisted JSON
    ok('publish: the new map ids are published chart types', sanitize.PUBLISHED_CHART_TYPES.has('map_hexbin') && sanitize.PUBLISHED_CHART_TYPES.has('map_flow'));
  }

  // The reference answers what the resident path must not: a warning.
  {
    hydrations = 0;
    const warned = await geoViz.geoVizReply(proj.id, ds.id, sanitizeEncoding(hexEnc('count')), [{ type: 'filter', column: 'nope', op: '=', value: 1 }]);
    ok('a filter that would warn goes to the JS reference, warning included', !!warned && warned.ok && hydrations === 1
      && warned.warnings.some((w: string) => /unknown column "nope"/.test(w)));
    const bad = await geoViz.geoVizReply(proj.id, ds.id, sanitizeEncoding({ category: 'origin', values: [], geo: { level: 'hexbin', lat: 'origin', lon: 'lng' } }), []);
    ok('a text latitude column is refused with a reason', !!bad && bad.ok === false && /not a number column/.test(bad.error), bad && bad.error);
    const none = await geoViz.geoVizReply(proj.id, ds.id, sanitizeEncoding({ category: 'origin', values: [], geo: { level: 'point' } }), []);
    ok('any other geo level is not this module\'s', none === null);
  }
}

main()
  .catch((err) => ok('unexpected error', false, err && err.stack))
  .finally(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    if (failureCount() > 0) {
      console.error(`\n${failureCount()} geoAgg check(s) failed.`);
      process.exit(1);
    }
    console.log('\nAll geoAgg checks passed.');
    process.exit(0);
  });
