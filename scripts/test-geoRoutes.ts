// Self-check for the maps' server half (T1.3): the bundled boundary GeoJSON
// under /api/geo (src/server/geo.ts) — hashed immutable URLs, gzip, no path
// ever reaching the filesystem, sign-in required — and the map data channels
// (src/api/maps.ts) over REAL HTTP in server mode with Electron forbidden:
// region, bubble, point, hexbin and flow replies from `visual:data`, the
// radius control's `geo:resolvePlace`, and inputs the contracts refuse.
//
//   npm run build:ts && node scripts/test-geoRoutes.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const zlib: typeof import('zlib') = require('zlib');
const Module: any = require('module'); // any: the loader hook has no public type

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const { fastify }: typeof import('fastify') = require('fastify');
const geo: typeof import('../src/server/geo') = require('../src/server/geo');
const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const { contracts }: typeof import('../src/api/index') = require('../src/api/index');
const { geoFixture }: typeof import('./geoFixture') = require('./geoFixture');

const SAMPLE_CSV = path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv');

(async () => {
  // ── The geo routes on their own ───────────────────────────────────────────
  const bare = fastify();
  geo.registerGeoRoutes(bare);
  await bare.ready();
  const idx = await bare.inject({ url: '/api/geo/index.json' });
  const index = idx.json() as Record<string, string>;
  ok('index: 200, revalidated (no-cache)', idx.statusCode === 200 && idx.headers['cache-control'] === 'no-cache', idx.headers['cache-control']);
  ok('index: the three bundled levels, each at a content-hashed URL',
    ['country', 'us_state', 'us_county'].every((l) => new RegExp(`^/api/geo/${l}\\.[0-9a-f]{16}\\.json$`).test(index[l] || '')), JSON.stringify(index));

  const features: Record<string, number> = {};
  for (const [level, url] of Object.entries(index)) {
    const res = await bare.inject({ url });
    const fc = res.json() as { type: string; features: unknown[] };
    features[level] = fc.features.length;
    ok(`${level}: 200 JSON FeatureCollection`, res.statusCode === 200 && fc.type === 'FeatureCollection' && String(res.headers['content-type']).startsWith('application/json'));
    ok(`${level}: immutable for a year, varies on encoding`,
      res.headers['cache-control'] === 'public, max-age=31536000, immutable' && res.headers.vary === 'Accept-Encoding', res.headers['cache-control']);
    const gz = await bare.inject({ url, headers: { 'accept-encoding': 'gzip, deflate, br' } });
    ok(`${level}: gzip when asked, byte-identical once inflated`,
      gz.headers['content-encoding'] === 'gzip' && zlib.gunzipSync(gz.rawPayload).equals(res.rawPayload) && gz.rawPayload.length < res.rawPayload.length / 2,
      `${gz.rawPayload.length} vs ${res.rawPayload.length}`);
  }
  ok('feature counts: 52 states, 3,221 counties, every country', features.us_state === 52 && features.us_county === 3221 && features.country > 150, JSON.stringify(features));

  const stale = (index.us_state || '').replace(/\.[0-9a-f]{16}\./, '.0000000000000000.');
  const misses = [
    stale, '/api/geo/us_state.json', '/api/geo/us-states.js', '/api/geo/us-counties.json',
    '/api/geo/..%2F..%2Fpackage.json', '/api/geo/%2e%2e%2f%2e%2e%2fpackage.json', '/api/geo/../../package.json',
    '/api/geo/..%5C..%5Cpackage.json', '/api/geo/%2Fetc%2Fpasswd', '/api/geo/places.json.gz',
  ];
  for (const url of misses) {
    const res = await bare.inject({ url });
    ok(`no file outside the three: ${url} → 404`, res.statusCode === 404 && !res.body.includes('"dependencies"') && !res.body.includes('root:'), `${res.statusCode} ${res.body.slice(0, 80)}`);
  }
  await bare.close();

  // A deploy without postinstall's files, or with a truncated one: the level is absent, never a broken 200.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-geo-'));
  fs.writeFileSync(path.join(dir, 'us-states.js'), 'window.__GEO_US_STATES__ = {"type":"FeatureCollection","features":[');
  fs.writeFileSync(path.join(dir, 'world-countries.js'), '/* x */\nwindow.__GEO_WORLD__ = {"type":"FeatureCollection","features":[]};\n');
  const partial = fastify();
  geo.registerGeoRoutes(partial, dir);
  const pIndex = (await partial.inject({ url: '/api/geo/index.json' })).json() as Record<string, string>;
  ok('a truncated or missing file leaves its level out of the index', Object.keys(pIndex).join() === 'country', JSON.stringify(pIndex));
  await partial.close();
  fs.rmSync(dir, { recursive: true, force: true });
  ok('geoJsonText strips the script wrapper', geo.geoJsonText('a.js', '/* c */\nwindow.__GEO_X__ = {"a":1};\n') === '{"a":1}');

  // ── The contracts, as zod sees them ───────────────────────────────────────
  const P = '0b6c3c55-6a5e-4c8e-9a1f-2f1d6c1b7e10';
  const vd = contracts['visual:data'].input;
  const enc = { category: 'state', values: [{ column: 'profit', aggregation: 'sum' }], geo: { level: 'us_state' } };
  ok('visual:data takes a map encoding', vd.safeParse({ projectId: P, datasetId: P, encoding: enc }).success);
  ok('…and a radius filter', vd.safeParse({ projectId: P, datasetId: P, encoding: enc, filters: [{ type: 'filter', column: 'lat', op: 'within_km', radius: { lngColumn: 'lon', lat: 30.27, lng: -97.74, km: 25, place: 'Austin, TX' } }] }).success);
  ok('visual:data refuses an unknown map level', !vd.safeParse({ projectId: P, datasetId: P, encoding: { ...enc, geo: { level: 'mars' } } }).success);
  // One channel serves charts (T1.1) and maps: a chart shelf such as `pivot` is valid input; the handler's
  // sanitizeEncoding whitelists it field by field.
  ok('visual:data (shared with charts) takes a chart shelf too (pivot)', vd.safeParse({ projectId: P, datasetId: P, encoding: { ...enc, pivot: {} } }).success);
  ok('visual:data refuses a non-UUID dataset', !vd.safeParse({ projectId: P, datasetId: '../x', encoding: enc }).success);
  ok('visual:data refuses a radius off the globe', !vd.safeParse({ projectId: P, datasetId: P, encoding: enc, filters: [{ type: 'filter', column: 'lat', op: 'within_km', radius: { lngColumn: 'lon', lat: 91, lng: 0, km: 5 } }] }).success);
  ok('boundary:get is project-scoped', 'project' in contracts['boundary:get'] && contracts['boundary:get'].project({ projectId: P, id: P }) === P);

  // ── Server mode, real HTTP ────────────────────────────────────────────────
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-geoapi-'));
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const who = (org: string): import('../src/server/context').Identity => ({ user: { email: `${org}@test`, role: 'admin' }, org: { id: org } });
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) =>
    typeof h['x-test-org'] === 'string' ? who(h['x-test-org']) : null);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as import('net').AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const call = async (channel: string, payload: unknown, org = 'org-a') => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST', body: wire.encode({ args: [payload] }), headers: withCsrf({ 'content-type': 'application/json', 'x-test-org': org }),
    });
    return { status: res.status, body: wire.decode(await res.text()) as any }; // any: each channel's own reply
  };

  try {
    ok('signed out: /api/geo is 401', (await fetch(`${base}/api/geo/index.json`)).status === 401);
    const signedIn = await fetch(`${base}/api/geo/index.json`, { headers: { 'x-test-org': 'org-a' } });
    ok('signed in: /api/geo/index.json is 200 in the full app', signedIn.status === 200 && 'us_state' in ((await signedIn.json()) as object));

    const { parseFile } = require('../src/data/fileImport') as typeof import('../src/data/fileImport');
    const seeded = await context.runInContext(who('org-a'), 'seed', async () => {
      const p = await projects.createProject('Maps');
      const csv = await parseFile(SAMPLE_CSV, 'csv' as never);
      const retail = await datasets.saveDataset(p.id, { name: 'Retail', sourceKind: 'csv' as never, columns: csv.columns, rows: csv.rows });
      const g = geoFixture();
      const ship = await datasets.saveDataset(p.id, { name: 'Shipments', sourceKind: 'csv' as never, columns: g.columns, rows: g.rows });
      return { projectId: p.id, retail: retail!.id, ship: ship!.id };
    });
    const measure = (column: string, aggregation = 'sum') => [{ column, aggregation }];
    const data = (datasetId: string, encoding: object) => call('visual:data', { projectId: seeded.projectId, datasetId, encoding });

    const choro = await data(seeded.retail, { category: 'state', values: measure('profit'), geo: { level: 'us_state' } });
    const items = choro.body?.data?.geo?.items || [];
    ok('choropleth: region items with numbers, the click column beside them',
      choro.status === 200 && choro.body.ok && items.length >= 10 && items.every((i: any) => typeof i.name === 'string' && typeof i.value === 'number') && choro.body.data.markColumn === 'state',
      JSON.stringify(choro.body).slice(0, 200));

    const points = await data(seeded.ship, { category: 'city', values: measure('weight_kg'), geo: { level: 'point', lat: 'lat', lon: 'lon', color: 'carrier' } });
    const pg = points.body?.data?.geo;
    ok('point map: every row placed, coloured by carrier', points.status === 200 && pg?.points === true && pg.items.length === 2400 && pg.colorColumn === 'carrier' && pg.skipped === 0,
      JSON.stringify(pg && { n: pg.items.length, skipped: pg.skipped }));

    const hex = await data(seeded.ship, { category: 'city', values: measure('weight_kg'), geo: { level: 'hexbin', lat: 'lat', lon: 'lon' } });
    const hx = hex.body?.data?.geo?.hex;
    ok('hexbin: levels of hexagons over all 2,400 points', hex.status === 200 && hx && hx.points === 2400 && hx.levels.length > 0 && hx.levels.every((l: any) => Array.isArray(l.hexes) && l.hexes.every((h: any) => h.ring.length === 12)),
      JSON.stringify(hx && { points: hx.points, levels: hx.levels.length }));

    const flow = await data(seeded.ship, { category: 'city', values: measure('weight_kg'), geo: { level: 'flow', lat: 'wh_lat', lon: 'wh_lon', lat2: 'city_lat', lon2: 'city_lon', from: 'warehouse', to: 'city' } });
    const fl = flow.body?.data?.geo?.flow;
    ok('flow: named routes with arcs, heaviest first', flow.status === 200 && fl && fl.flows.length > 10 && fl.flows.every((f: any) => / → /.test(f.name) && f.path.length >= 4)
      && fl.flows.every((f: any, i: number) => i === 0 || f.value <= fl.flows[i - 1].value), JSON.stringify(fl && { routes: fl.routes, drawn: fl.flows.length }));

    const bad = await call('visual:data', { projectId: seeded.projectId, datasetId: seeded.ship, encoding: { category: 'city', values: [], geo: { level: 'mars' } } });
    ok('an invalid encoding is a 400 naming the path, not the value', bad.status === 400 && JSON.stringify(bad.body).includes('encoding.geo.level') && !JSON.stringify(bad.body).includes('mars'), JSON.stringify(bad.body));
    const elsewhere = await call('visual:data', { projectId: seeded.projectId, datasetId: seeded.ship, encoding: { category: 'city', values: measure('weight_kg'), geo: { level: 'point' } } }, 'org-b');
    ok('another org cannot read the project (403 before the handler)', elsewhere.status === 403, elsewhere.status);

    const place = await call('geo:resolvePlace', { text: 'Austin, TX' });
    ok('geo:resolvePlace: a known city resolves to coordinates', place.status === 200 && place.body.ok && Math.abs(place.body.place.lat - 30.27) < 0.2, JSON.stringify(place.body));
    const nowhere = await call('geo:resolvePlace', { text: 'Atlantis' });
    ok('geo:resolvePlace: an unknown place says so', nowhere.status === 200 && nowhere.body.ok === false && /Atlantis/.test(nowhere.body.error));

    const missing = await call('boundary:get', { projectId: seeded.projectId, id: P });
    ok('boundary:get: a missing custom set is ok:false, not a 500', missing.status === 200 && missing.body.ok === false, JSON.stringify(missing.body));
  } finally {
    await app.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
