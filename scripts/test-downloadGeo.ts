// Self-check for scripts/download-geo.ts (NV-15). The committed assets/geo copy
// is the reviewed one the image ships, so the script never replaces it unless
// asked (--refresh), a failed refresh keeps it, and a redirect off https is
// never followed. Runs a COPY of the script in a scratch tree with https.get
// stubbed by a preload: no network, and the repo's own files are never touched.
//
//   npm run build:ts && node scripts/test-downloadGeo.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = ['world-countries.js', 'us-states.js', 'us-counties.json'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-geo-'));
const geo = path.join(tmp, 'assets', 'geo');
const log = path.join(tmp, 'requests.log');
const stub = path.join(tmp, 'stub.js');

// Every get is logged; it answers a one-feature fixture, or a 302 to plain http.
fs.writeFileSync(stub, `
const fs = require('fs');
const { PassThrough } = require('stream');
const FIXTURE = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
  properties: { name: 'Fixture-Renamed', NAME: 'Fixture-Renamed' },
  geometry: { type: 'Polygon', coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]] } }] });
for (const name of ['https', 'http']) {
  require(name).get = (url, _opts, cb) => {
    fs.appendFileSync(process.env.GEO_STUB_LOG, url + '\\n');
    const res = new PassThrough();
    const hop = process.env.GEO_STUB_MODE === 'redirect';
    res.statusCode = hop ? 302 : 200;
    res.headers = hop ? { location: 'http://evil.test/world.geojson' } : {};
    process.nextTick(() => { cb(res); res.end(hop ? '' : FIXTURE); });
    return { on() { return this; } };
  };
}
`);

function reset(): void {
  fs.rmSync(geo, { recursive: true, force: true });
  fs.mkdirSync(geo, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'download-geo.js'), path.join(tmp, 'scripts', 'download-geo.js'));
  for (const f of FILES) fs.copyFileSync(path.join(ROOT, 'assets', 'geo', f), path.join(geo, f));
  fs.writeFileSync(log, '');
}

function run(mode: string, ...args: string[]): { status: number | null; requests: string[] } {
  const r = spawnSync(process.execPath, ['--require', stub, path.join(tmp, 'scripts', 'download-geo.js'), ...args], {
    env: { ...process.env, GEO_STUB_LOG: log, GEO_STUB_MODE: mode }, encoding: 'utf8',
  });
  return { status: r.status, requests: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

const same = (f: string): boolean => fs.readFileSync(path.join(geo, f)).equals(fs.readFileSync(path.join(ROOT, 'assets', 'geo', f)));

try {
  reset();
  const plain = run('fixture');
  ok('NV-15: with the committed files present, no fetch at all', plain.status === 0 && plain.requests.length === 0, plain.requests);
  ok('NV-15: …and every committed file is byte-for-byte unchanged', FILES.every(same));

  reset();
  fs.rmSync(path.join(geo, 'us-states.js'));
  const missing = run('fixture');
  ok('control: a MISSING file is fetched (the stub is what answers)', missing.status === 0 && missing.requests.length === 1 && missing.requests[0].includes('us-states'), missing.requests);
  ok('control: …and written from the fetched content', fs.readFileSync(path.join(geo, 'us-states.js'), 'utf8').includes('Fixture-Renamed'));
  ok('control: …the present ones untouched', same('world-countries.js') && same('us-counties.json'));

  reset();
  const hop = run('redirect', '--refresh');
  ok('NV-15: --refresh never follows a redirect off https', hop.status === 0 && hop.requests.length === FILES.length && hop.requests.every((u) => u.startsWith('https://')), hop.requests);
  ok('NV-15: a failed --refresh keeps the committed copy (no empty placeholder over it)', FILES.every(same));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
finish();
