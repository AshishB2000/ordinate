// Self-check for the data grid's two channels over the real RPC route (T1.4):
// `dataset:page` (one window of rows) and `dataset:columns` (the header).
//
// 1. Good input → 200, byte-identical to the handler called directly — incl.
//    the exact request shape the desktop preload sends.
// 2. Paging is a partition: the 500-row pages the grid fetches, concatenated,
//    are Object.is-equal to ONE 5,000-row window — unsorted and sorted on a
//    column full of ties (order_date), where only the ordinal tiebreak keeps
//    a row from landing on two pages or none.
// 3. The zod input refuses what the engine would otherwise clamp or skip.
// 4. `dataset:columns` returns name / rowCount / columns and NOTHING about the
//    origin (a URL with a key in it, here).
//
//   npm run build:ts && node scripts/test-datasetPageRpc.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dspage-rpc-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

type Cell = import('../src/data/transforms').Cell;
type Page = { ok: true; rows: Cell[][]; total: number; offset: number };

const SECRET = 'S3CRET-api-key-do-not-echo';

/** '' when equal with Object.is at every leaf, else the first difference's path. */
function firstDiff(a: unknown, b: unknown, at = '$'): string {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${at}: length`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return '';
  }
  return Object.is(a, b) ? '' : `${at}: ${String(a)} vs ${String(b)}`;
}

(async () => {
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  await projects.init();
  const projectId = String((await sample.seedSampleProject()).projectId);
  const datasetId = (await datasets.listDatasets(projectId))[0].id;

  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent' }));
  const post = (channel: string, payload: unknown) => app.inject({
    method: 'POST',
    url: `/api/rpc/${encodeURIComponent(channel)}`,
    headers: withCsrf({ 'content-type': 'application/json' }),
    payload: wire.encode({ args: [payload] }),
  });
  const direct = async (ch: string, p: unknown): Promise<string> => wire.encode(await rpc.handlers.get(ch)!(null, p));
  const page = async (req: Record<string, unknown>): Promise<Page> => {
    const r = await post('dataset:page', { projectId, datasetId, ...req });
    if (r.statusCode !== 200) throw new Error(`dataset:page ${r.statusCode} ${r.body}`);
    return wire.decode(r.body) as Page;
  };

  // ── 1. Good input ≡ the handler ──────────────────────────────────────────
  const req = { projectId, datasetId, offset: 0, limit: 100 };
  const first = await post('dataset:page', req);
  ok('dataset:page: 200', first.statusCode === 200, first.body.slice(0, 200));
  ok('dataset:page: body ≡ the handler called directly', first.body === await direct('dataset:page', req));
  const p0 = wire.decode(first.body) as Page;
  ok('dataset:page: 100 rows of 5,000', p0.ok === true && p0.rows.length === 100 && p0.total === 5000, `${p0.rows?.length} / ${p0.total}`);

  const preload = { projectId, datasetId, offset: 500, limit: 500, search: '', sortColumn: '', sortDir: 'asc', filters: undefined };
  const pr = await post('dataset:page', preload);
  ok('the desktop preload\'s request shape: 200 ≡ direct', pr.statusCode === 200 && pr.body === await direct('dataset:page', preload), pr.body.slice(0, 200));

  const filtered = { projectId, datasetId, offset: 0, limit: 50, filters: [{ type: 'filter', column: 'region', op: '=', value: 'East' }] };
  const fr = await post('dataset:page', filtered);
  const fv = wire.decode(fr.body) as Page;
  ok('a filter step: 200 ≡ direct', fr.statusCode === 200 && fr.body === await direct('dataset:page', filtered), fr.body.slice(0, 200));
  ok('…and it filtered (total < 5,000, every row East)', fv.total > 0 && fv.total < 5000 && fv.rows.every((r) => r[1] === 'East'), String(fv.total));

  // ── 2. Pages partition the window ────────────────────────────────────────
  for (const sort of [{}, { sortColumn: 'order_date', sortDir: 'asc' }, { sortColumn: 'order_date', sortDir: 'desc' }]) {
    const label = 'sortColumn' in sort ? `sorted ${sort.sortDir} on a column of ties` : 'unsorted';
    const whole = await page({ offset: 0, limit: 5000, ...sort });
    const parts: Cell[][] = [];
    for (let off = 0; off < 5000; off += 500) parts.push(...(await page({ offset: off, limit: 500, ...sort })).rows);
    const diff = firstDiff(parts, whole.rows);
    ok(`${label}: ten 500-row pages ≡ one 5,000-row window`, whole.rows.length === 5000 && diff === '', diff);
  }
  const past = await page({ offset: 5000, limit: 500 });
  ok('a page past the end is empty and still says the total', past.rows.length === 0 && past.total === 5000);

  // ── 3. Input the contract refuses ────────────────────────────────────────
  const bad: [string, Record<string, unknown>, string][] = [
    ['limit over the engine ceiling', { limit: 5001 }, 'args.0.limit'],
    ['negative offset', { offset: -1 }, 'args.0.offset'],
    ['fractional offset', { offset: 1.5 }, 'args.0.offset'],
    ['NaN limit', { limit: NaN }, 'args.0.limit'],
    ['sortDir not asc|desc', { sortDir: SECRET }, 'args.0.sortDir'],
    ['a non-filter step', { filters: [{ type: 'sort', column: 'x', op: 'eq' }] }, 'args.0.filters.0.type'],
    ['a filter with an unknown key', { filters: [{ type: 'filter', column: 'x', op: 'eq', [SECRET]: 1 }] }, 'args.0.filters.0'],
    ['an unknown key', { [SECRET]: SECRET }, 'args.0'],
    ['datasetId not a UUID', { datasetId: `../${SECRET}` }, 'args.0.datasetId'],
  ];
  for (const [label, patch, at] of bad) {
    const r = await post('dataset:page', { ...req, ...patch });
    const j = (() => { try { return r.json(); } catch { return null; } })();
    ok(`400 ${label}, naming ${at}, never the value`,
      r.statusCode === 400 && Array.isArray(j?.issues) && j.issues.some((i: { path: string }) => i.path === at) && !r.body.includes(SECRET),
      `${r.statusCode} ${r.body}`);
  }

  // ── 4. dataset:columns says nothing about the origin ─────────────────────
  const withUrl = await datasets.saveDataset(projectId, {
    name: 'From a URL',
    sourceKind: 'json',
    columns: [{ name: 'a', type: 'number' }, { name: 'b', type: 'text' }],
    rows: [[1, 'x'], [2, 'y']],
    origin: { kind: 'url', url: `https://example.com/data.json?api_key=${SECRET}` },
  });
  ok('fixture: a dataset with a URL origin was saved', !!withUrl);
  const meta = await direct('dataset:meta', { projectId, id: withUrl!.id });
  ok('negative control: dataset:meta does carry the key', meta.includes(SECRET));
  const cr = await post('dataset:columns', { projectId, id: withUrl!.id });
  const cv = wire.decode(cr.body) as Record<string, unknown>;
  ok('dataset:columns: 200', cr.statusCode === 200, cr.body);
  ok('dataset:columns: exactly id, name, rowCount, columns', Object.keys(cv).sort().join() === 'columns,id,name,rowCount', Object.keys(cv).join());
  ok('dataset:columns: name, rowCount and typed columns', cv.name === 'From a URL' && cv.rowCount === 2
    && JSON.stringify(cv.columns) === '[{"name":"a","type":"number"},{"name":"b","type":"text"}]', cr.body);
  ok('dataset:columns: never the origin', !cr.body.includes(SECRET) && !cr.body.includes('example.com'), cr.body);
  const none = await post('dataset:columns', { projectId, id: '1b4e28ba-2fa1-11d2-883f-0016d3cca427' });
  ok('dataset:columns: an unknown dataset → null', none.statusCode === 200 && wire.decode(none.body) === null, none.body);

  await app.close();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    finish();
  });
