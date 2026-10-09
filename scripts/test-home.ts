// Self-check for Home's and the chrome's server channels (T2.1) — REAL HTTP,
// server mode:
//
//   home:overview   counts and lists equal the stores' own (differential), and
//                   only the picked fields leave (no origin, no crop path)
//   starred:*       per USER: one member's pins never move another's; a user
//                   with none sees the org's seeded pins; orgs never mix
//   onboarding:*    any member reads the card; only an editor+ folds it
//   jobs:*          a user lists, cancels and clears only their own jobs, and
//                   never sees a server file path; no jobs:reveal on a server
//   prefs:get       formats + branding, nothing else
//
//   npm run build:ts && node scripts/test-home.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');

type Identity = import('../src/server/context').Identity;
type Role = import('../src/server/context').Role;
type Snap = import('../src/app/jobs').JobsSnapshot;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-home-'));
const who = (org: string, user: string, role: Role = 'admin'): Identity => ({ user: { email: `${user}@${org}`, role }, org: { id: org } });
let port = 0;

function rpc(org: string, user: string, channel: string, payload?: unknown, role: Role = 'admin'): Promise<{ status: number; body: any }> { // any: each reply is narrowed by the assertion that reads it
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: `/api/rpc/${channel}`,
      headers: withCsrf({ 'content-type': 'application/json', 'x-test-org': org, 'x-test-user': user, 'x-test-role': role }),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: res.statusCode === 200 ? wire.decode(text) : text }));
    });
    req.on('error', reject);
    req.end(wire.encode({ args: payload === undefined ? [] : [payload] }));
  });
}

const ids = (s: Snap): string[] => [...s.active, ...s.recent].map((j) => j.id);

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) => {
    const org = h['x-test-org'];
    const user = h['x-test-user'];
    const role = h['x-test-role'];
    return typeof org === 'string' && typeof user === 'string' ? who(org, user, role === 'viewer' ? 'viewer' : 'admin') : null;
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as import('net').AddressInfo).port;

  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const config: typeof import('../src/app/config') = require('../src/app/config');
  const onboarding: typeof import('../src/app/onboarding') = require('../src/app/onboarding');
  const qr: typeof import('../src/analysis/qualityRun') = require('../src/analysis/qualityRun');

  // org-a: one project, two datasets, five visuals, a quality rule, the org's seeded pin, first-run state.
  const seed = await context.runInContext(who('org-a', 'u1'), 'seed', async () => {
    const p = await projects.createProject('Home project');
    const save = (name: string) => datasets.saveDataset(p.id, {
      name, sourceKind: 'csv',
      columns: [{ name: 'zip', type: 'text' }, { name: 'amount', type: 'number' }],
      rows: [['007', 1.5], ['010', 2]],
    });
    const a = await save('Orders');
    const b = await save('Returns');
    if (!a || !b) throw new Error('dataset not saved');
    for (let i = 0; i < 5; i++) {
      await visuals.saveVisual(p.id, { name: `V${i}`, datasetId: a.id, chartType: 'bar', encoding: { category: 'zip', values: [{ column: 'amount', aggregation: 'sum' }] } });
    }
    const r = await qr.saveRule(p.id, a.id, { kind: 'not_null', column: 'zip', args: {}, severity: 'fail' });
    if (!r.ok) throw new Error(r.error);
    config.setStarred(['analysis:seeded']);
    config.save({ onboarding: onboarding.fresh() });
    return { pid: p.id, dsid: a.id };
  });

  // ── home:overview ─────────────────────────────────────────────────────────
  const ov = await rpc('org-a', 'u1', 'home:overview', { projectId: seed.pid });
  const direct = await context.runInContext(who('org-a', 'u1'), 'direct', async () => ({
    ds: await datasets.listDatasets(seed.pid),
    vis: await visuals.listVisuals(seed.pid),
  }));
  ok('home:overview: 200', ov.status === 200, JSON.stringify(ov.body));
  ok('counts equal the stores\' own lists', ov.body.counts.datasets === direct.ds.length && ov.body.counts.visuals === direct.vis.length
    && ov.body.counts.dashboards === 0 && ov.body.counts.captures === 0, JSON.stringify(ov.body.counts));
  ok('the datasets are the store\'s, in its order, with the same figures', ov.body.datasets.length === 2
    && ov.body.datasets.every((d: any, i: number) => d.id === direct.ds[i].id && Object.is(d.rowCount, direct.ds[i].rowCount) && Object.is(d.columnCount, direct.ds[i].columnCount)), // any: a reply row
  JSON.stringify(ov.body.datasets));
  ok('only the picked fields leave (no origin, no crop path, no source kind)',
    ov.body.datasets.every((d: object) => Object.keys(d).every((k) => ['id', 'name', 'rowCount', 'columnCount', 'qualityFailing'].includes(k))), JSON.stringify(ov.body.datasets));
  ok('the first four visuals, in the store\'s order, as id/name/chartType',
    ov.body.visuals.length === 4 && ov.body.visuals.every((v: any, i: number) => v.id === direct.vis[i].id && Object.keys(v).length === 3), JSON.stringify(ov.body.visuals)); // any: a reply row
  ok('home:overview needs a UUID → 400', (await rpc('org-a', 'u1', 'home:overview', { projectId: 'x' })).status === 400);
  ok('another org\'s caller is refused the project → 403', (await rpc('org-b', 'u1', 'home:overview', { projectId: seed.pid })).status === 403);

  // ── starred: per user ─────────────────────────────────────────────────────
  const get = async (org: string, user: string) => (await rpc(org, user, 'starred:get')).body as string[];
  ok('a user with no pins sees the org\'s seeded pin', JSON.stringify(await get('org-a', 'u1')) === '["analysis:seeded"]');
  const set = await rpc('org-a', 'u1', 'starred:set', { ids: ['dataset:a', 'dataset:a', 'analysis:b'] });
  ok('starred:set: 200, deduped', set.status === 200 && JSON.stringify(set.body.starred) === '["dataset:a","analysis:b"]', JSON.stringify(set.body));
  ok('u1 now reads their own pins', JSON.stringify(await get('org-a', 'u1')) === '["dataset:a","analysis:b"]');
  ok('u2 in the same org still sees the org\'s pin, not u1\'s', JSON.stringify(await get('org-a', 'u2')) === '["analysis:seeded"]');
  ok('another org sees none of it', JSON.stringify(await get('org-b', 'u1')) === '[]');
  ok('a viewer may pin (their own preference)', (await rpc('org-a', 'v', 'starred:set', { ids: ['dataset:a'] }, 'viewer')).status === 200);
  ok('u1 unpinning everything keeps an empty list (not the org\'s)', (await rpc('org-a', 'u1', 'starred:set', { ids: [] })).status === 200
    && JSON.stringify(await get('org-a', 'u1')) === '[]');
  ok('the org list itself never moved', JSON.stringify(await context.runInContext(who('org-a', 'u1'), 'x', async () => config.get().starred)) === '["analysis:seeded"]');
  ok('a non-string pin → 400', (await rpc('org-a', 'u1', 'starred:set', { ids: [1] })).status === 400);

  // ── onboarding ────────────────────────────────────────────────────────────
  const st = await rpc('org-a', 'v', 'onboarding:status', undefined, 'viewer');
  ok('a viewer reads the card: started, import done (two datasets), visual done', st.status === 200 && st.body.started === true
    && st.body.steps.find((s: { id: string }) => s.id === 'import').done === true, JSON.stringify(st.body));
  ok('a viewer may not fold the org\'s card → 403', (await rpc('org-a', 'v', 'onboarding:set', { collapsed: true }, 'viewer')).status === 403);
  ok('an admin folds it', (await rpc('org-a', 'u1', 'onboarding:set', { collapsed: true })).body?.ok === true
    && (await rpc('org-a', 'u1', 'onboarding:status')).body.collapsed === true);
  ok('dismissed: false is not a thing a tab can send → 400', (await rpc('org-a', 'u1', 'onboarding:set', { dismissed: false })).status === 400);

  // ── jobs: the caller's own ────────────────────────────────────────────────
  const run = await rpc('org-a', 'u1', 'quality:run', { projectId: seed.pid, datasetId: seed.dsid });
  ok('u1 runs a real job (quality:run)', run.status === 200 && run.body.ok === true, JSON.stringify(run.body));
  const withPath = await context.runInContext(who('org-a', 'u1'), 'job', async () => {
    const j = jobs.submit({ kind: 'export', label: 'An export', run: async () => '/srv/secret/out.pdf', resultOf: (p) => ({ path: p, message: 'Saved' }) });
    await j.done;
    return j.id;
  });
  const l1 = (await rpc('org-a', 'u1', 'jobs:list')).body as Snap;
  ok('u1 lists both of their jobs', l1.recent.length === 2 && ids(l1).includes(withPath), JSON.stringify(l1));
  ok('no job a tab gets carries a path, an owner or a stream number',
    !/"(path|owner|client)"/.test(JSON.stringify(l1)) && l1.recent.find((j) => j.id === withPath)?.result?.message === 'Saved', JSON.stringify(l1));
  ok('…while the server\'s own record keeps the path', jobs.get(withPath)?.result?.path === '/srv/secret/out.pdf');
  ok('u2 (same org) lists none of u1\'s', ids((await rpc('org-a', 'u2', 'jobs:list')).body).length === 0);
  ok('another org lists none of them', ids((await rpc('org-b', 'u1', 'jobs:list')).body).length === 0);
  const queued = await context.runInContext(who('org-a', 'u1'), 'job', async () =>
    jobs.submit({ kind: 'compute', label: 'Long', run: (c) => new Promise((_r, rej) => c.signal.addEventListener('abort', () => rej(new jobs.JobCancelled()))) }));
  queued.done.catch(() => { /* cancelled below */ });
  ok('u2 cancelling u1\'s job → ok:false, still running', (await rpc('org-a', 'u2', 'jobs:cancel', { id: queued.id })).body.ok === false && jobs.get(queued.id)?.state !== 'cancelled');
  ok('u1 cancels their own', (await rpc('org-a', 'u1', 'jobs:cancel', { id: queued.id })).body.ok === true);
  await queued.done.catch(() => undefined);
  const other = await context.runInContext(who('org-a', 'u2'), 'job', async () => {
    const j = jobs.submit({ kind: 'compute', label: 'u2 work', run: async () => 1 });
    await j.done;
    return j.id;
  });
  ok('u2 clearing clears only u2\'s finished jobs', (await rpc('org-a', 'u2', 'jobs:clear')).status === 200
    && jobs.get(other) === null && jobs.get(withPath) !== null);
  await rpc('org-a', 'u1', 'jobs:clear');
  ok('u1 clearing clears theirs', ids((await rpc('org-a', 'u1', 'jobs:list')).body).length === 0);
  ok('jobs:reveal has no contract on a server → 404', (await rpc('org-a', 'u1', 'jobs:reveal', { id: withPath })).status === 404);
  ok('jobs:cancel needs a UUID → 400', (await rpc('org-a', 'u1', 'jobs:cancel', { id: '../x' })).status === 400);

  // ── visual:dataBatch ≡ visual:data per item (differential) ────────────────
  // The batch the shell's RPC budget leans on must answer exactly what one call does.
  const items = [
    { datasetId: seed.dsid, encoding: { category: 'zip', values: [{ column: 'amount', aggregation: 'sum' }] } },
    { datasetId: seed.dsid, encoding: { category: 'zip', values: [{ column: 'amount', aggregation: 'avg' }] } },
    { datasetId: seed.dsid, encoding: { category: 'zip', values: [{ column: 'amount', aggregation: 'count' }] }, filters: [{ type: 'filter', column: 'zip', op: '=', value: '007' }] },
    { datasetId: seed.dsid, encoding: { category: 'nope', values: [{ column: 'amount', aggregation: 'sum' }] } },
  ];
  const batch = await rpc('org-a', 'u1', 'visual:dataBatch', { projectId: seed.pid, items });
  const singles = await Promise.all(items.map((it) => rpc('org-a', 'u1', 'visual:data', { projectId: seed.pid, ...it })));
  ok('visual:dataBatch: 200, one answer per item', batch.status === 200 && Array.isArray(batch.body) && batch.body.length === items.length, JSON.stringify(batch.body));
  ok('each answer is wire-identical to the item\'s own visual:data (figures, refusals and all)',
    singles.every((one, i) => one.status === 200 && wire.encode(one.body) === wire.encode(batch.body[i])), JSON.stringify(singles.map((x) => x.body)));
  ok('…and the answers are real ones (a sum, and a warning for an unknown column)', batch.body[0].data.series[0].values[1] === 2 && /Unknown category column/.test(String(batch.body[3].warnings)), JSON.stringify(batch.body));
  ok('an item cannot name another project: the batch carries one projectId only → 400', (await rpc('org-a', 'u1', 'visual:dataBatch', { projectId: seed.pid, items: [{ ...items[0], projectId: seed.pid }] })).status === 400);
  ok('more than 50 items → 400', (await rpc('org-a', 'u1', 'visual:dataBatch', { projectId: seed.pid, items: Array(51).fill(items[0]) })).status === 400);
  ok('another org is refused the project → 403', (await rpc('org-b', 'u1', 'visual:dataBatch', { projectId: seed.pid, items })).status === 403);

  // ── prefs:get ─────────────────────────────────────────────────────────────
  const prefs = await rpc('org-a', 'v', 'prefs:get', undefined, 'viewer');
  ok('prefs:get: formats and branding only', prefs.status === 200 && JSON.stringify(Object.keys(prefs.body)) === '["formats","branding"]'
    && typeof prefs.body.branding.accent === 'string', JSON.stringify(prefs.body));

  await app.close();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
