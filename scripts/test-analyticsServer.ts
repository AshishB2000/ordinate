// Self-check for the analytics workbenches' server channels (T2.10) — REAL
// HTTP, server mode, on the bundled sample project:
//
//   stats:*        run / pair / saveFormula / addToDashboard; the derived
//                  `figures` and pair `line` equal the arithmetic the desktop
//                  renderer did, Object.is at every value
//   drivers:*      explain (each waterfall step's `from` = the running level),
//                  addTile (a waterfall visual)
//   scenario:*     CRUD, compute on a draft, compare (+ its `best` column),
//                  targets; scenario:metrics
//   segments:*     features, fit (+ `shares`), saveColumn, rfm, rfmSave
//   scope          another org's caller → 403; a bad spec → 400
//   Part 2 (DATABASE_URL): every channel × viewer / editor / admin grants on a
//                  scratch database — exactly the roles its access names, and a
//                  denied call never reaches its handler.
//
//   npm run build:ts && node scripts/test-analyticsServer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const { analytics }: typeof import('../src/api/analytics') = require('../src/api/analytics');

type Identity = import('../src/server/context').Identity;
type Reply = { status: number; body: any }; // any: each reply is narrowed by the assertion that reads it

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-analytics-'));
const who = (org: string): Identity => ({ user: { email: `u@${org}`, role: 'admin' }, org: { id: org } });

function client(base: string, headers: Record<string, string>) {
  return async (channel: string, payload?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json', ...headers }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
  };
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
}

/** The sample project (Retail orders + its six metrics), seeded as `as`. */
async function seedSample(as: Identity): Promise<{ pid: string; ds: string }> {
  return context.runInContext(as, 'seed', async () => {
    const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const pid = String((await sample.seedSampleProject()).projectId);
    return { pid, ds: (await datasets.listDatasets(pid))[0].id };
  });
}

async function partOne(): Promise<void> {
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) =>
    typeof h['x-test-org'] === 'string' ? who(h['x-test-org']) : null);
  const base = await listen(app);
  const call = client(base, { 'x-test-org': 'org-a' });
  const other = client(base, { 'x-test-org': 'org-b' });
  try {
    const { pid, ds } = await seedSample(who('org-a'));
    const spec = (extra: object) => ({ datasetId: ds, columns: [], ...extra });

    // ── Statistics ──────────────────────────────────────────────────────────
    const corr = await call('stats:run', { projectId: pid, spec: spec({ kind: 'correlation', columns: ['units', 'revenue', 'profit'], method: 'pearson' }) });
    ok('stats:run correlation: 200, a 3×3 matrix', corr.status === 200 && corr.body.result.ok && corr.body.result.matrix.columns.length === 3, JSON.stringify(corr.body).slice(0, 300));

    const grp = await call('stats:run', { projectId: pid, spec: spec({ kind: 'groups', group: 'region', outcome: 'revenue' }) });
    const g = grp.body.result;
    ok('stats:run groups: figures.total = Σ n (the desktop\'s fold)', grp.status === 200 && Object.is(grp.body.figures.total, g.groups.reduce((s: number, x: { n: number }) => s + x.n, 0)), JSON.stringify(grp.body.figures));

    const tab = await call('stats:run', { projectId: pid, spec: spec({ kind: 'groups', group: 'region', outcome: 'category' }) });
    const t = tab.body.result;
    const f = tab.body.figures;
    const rowsOk = t.mode === 'table' && t.table.counts.every((row: number[], i: number) => {
      const total = row.reduce((s, x) => s + x, 0);
      return Object.is(f.rowTotals[i], total) && row.every((x, j) => Object.is(f.rowShares[i][j], total ? x / total : 0));
    });
    ok('stats:run cross-tab: rowTotals and rowShares equal the desktop\'s arithmetic', tab.status === 200 && rowsOk, JSON.stringify(f).slice(0, 300));

    const reg = await call('stats:run', { projectId: pid, spec: spec({ kind: 'regression', target: 'revenue', predictors: ['units', 'discount', 'region'] }) });
    const fit = reg.body.result.fit;
    const fitted: number[] = fit.residuals.fitted;
    const q = fit.qq;
    ok('stats:run regression: residualSpan = [min, max] of fitted',
      reg.status === 200 && Object.is(reg.body.figures.residualSpan[0], Math.min(...fitted)) && Object.is(reg.body.figures.residualSpan[1], Math.max(...fitted)), JSON.stringify(reg.body.figures));
    ok('stats:run regression: qqSpan = the reference line\'s ends',
      Object.is(reg.body.figures.qqSpan[0], Math.min(q.theoretical[0], q.sample[0]))
      && Object.is(reg.body.figures.qqSpan[1], Math.max(q.theoretical[q.theoretical.length - 1], q.sample[q.sample.length - 1])));

    const dist = await call('stats:run', { projectId: pid, spec: spec({ kind: 'distribution', columns: ['revenue'] }) });
    ok('stats:run distribution: moments, histogram, normality', dist.status === 200 && dist.body.result.ok && dist.body.result.histogram.counts.length > 0 && !!dist.body.result.normality);

    const pair = await call('stats:pair', { projectId: pid, spec: spec({ kind: 'correlation', columns: ['units', 'revenue'] }), x: 'units', y: 'revenue' });
    const p = pair.body.pair;
    const lo = Math.min(...(p.points.x as number[]));
    const hi = Math.max(...(p.points.x as number[]));
    ok('stats:pair: line ends = intercept + slope × the observed x range', pair.status === 200
      && Object.is(pair.body.line.x0, lo) && Object.is(pair.body.line.x1, hi)
      && Object.is(pair.body.line.y0, p.fit.intercept + p.fit.slope * lo) && Object.is(pair.body.line.y1, p.fit.intercept + p.fit.slope * hi), JSON.stringify(pair.body.line));

    const bad = await call('stats:run', { projectId: pid, spec: { kind: 'nope', datasetId: ds } });
    ok('stats:run: an unknown kind → 400', bad.status === 400, bad.status);
    ok('stats:run: another org\'s caller → 403', (await other('stats:run', { projectId: pid, spec: spec({ kind: 'distribution', columns: ['revenue'] }) })).status === 403);

    const saved = await call('stats:saveFormula', { projectId: pid, spec: spec({ kind: 'regression', target: 'revenue', predictors: ['units'] }) });
    ok('stats:saveFormula: predicted_revenue as a calculated field', saved.status === 200 && saved.body.ok && saved.body.name === 'predicted_revenue', JSON.stringify(saved.body));
    const cols = await call('dataset:columns', { projectId: pid, id: ds });
    ok('stats:saveFormula: the dataset now has the column', cols.body.columns.some((c: { name: string }) => c.name === 'predicted_revenue'));

    const before = (await call('stats:dashboards', { projectId: pid })).body.length;
    const added = await call('stats:addToDashboard', { projectId: pid, spec: spec({ kind: 'distribution', columns: ['revenue'] }), view: 'chart', name: 'Stats board' });
    ok('stats:addToDashboard: a new dashboard with the card', added.status === 200 && added.body.ok && added.body.name === 'Stats board', JSON.stringify(added.body));
    const again = await call('stats:addToDashboard', { projectId: pid, spec: spec({ kind: 'correlation', columns: ['units', 'revenue'] }), view: 'table', analysisId: added.body.analysisId });
    const board = await context.runInContext(who('org-a'), 'get', async () => {
      const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
      return analysis.getAnalysis(pid, added.body.analysisId);
    });
    const cards = board ? board.sheets[board.sheets.length - 1].cards : [];
    const statsCards = cards.filter((c) => c.type === 'stats');
    ok('stats:addToDashboard: two stats cards, specs kept, the second below the first',
      again.status === 200 && statsCards.length === 2 && statsCards[0].stats?.view === 'chart' && statsCards[1].stats?.kind === 'correlation'
      && statsCards[1].layout.y >= statsCards[0].layout.y + statsCards[0].layout.h, JSON.stringify(cards.map((c) => c.layout)));
    ok('stats:dashboards: lists the new dashboard', (await call('stats:dashboards', { projectId: pid })).body.length === before + 1);

    // ── Key drivers ─────────────────────────────────────────────────────────
    const request = { datasetId: ds, metric: { column: 'revenue', aggregation: 'sum' }, compare: { mode: 'latest', column: 'order_date' } };
    const why = await call('drivers:explain', { projectId: pid, request });
    const sel = why.body.selected;
    let run = sel ? sel.waterfall.start : 0;
    let levels = !!sel && sel.waterfall.steps.length > 0;
    for (const st of sel ? sel.waterfall.steps : []) { if (!Object.is(st.from, run)) levels = false; run += st.delta; if (!Object.is(st.to, run)) levels = false; }
    ok('drivers:explain: a decomposition, ranked dimensions', why.status === 200 && why.body.ok && why.body.dimensions.length > 0, JSON.stringify(why.body).slice(0, 300));
    ok('drivers:explain: each step\'s `from`/`to` are the running levels; Other starts where the steps end', levels && Object.is(sel.waterfall.other.from, run) && Object.is(sel.waterfall.other.to, run + sel.waterfall.other.delta), JSON.stringify(sel?.waterfall).slice(0, 400));
    const drill = await call('drivers:explain', { projectId: pid, request: { ...why.body.spec, path: [{ column: sel.column, value: sel.waterfall.steps[0].key }] } });
    ok('drivers:explain: a drill path answers one level down', drill.status === 200 && drill.body.ok && drill.body.path.length === 1, JSON.stringify(drill.body).slice(0, 200));
    const tile = await call('drivers:addTile', { projectId: pid, request: { ...why.body.spec, dimension: sel.column }, name: 'Why revenue changed' });
    ok('drivers:addTile: a waterfall visual', tile.status === 200 && tile.body.ok && tile.body.visual.chartType === 'waterfall', JSON.stringify(tile.body).slice(0, 200));

    // ── Scenarios ───────────────────────────────────────────────────────────
    const ms = await call('scenario:metrics', { projectId: pid });
    const byName = (n: string): string => ms.body.find((m: { name: string }) => m.name === n).id;
    ok('scenario:metrics: the sample\'s six metrics', ms.status === 200 && ms.body.length === 6, JSON.stringify(ms.body).slice(0, 200));
    const base0 = [byName('Revenue'), byName('Profit')];
    const made = await call('scenario:create', { projectId: pid, input: { name: 'Price +5%', baseMetricIds: base0, drivers: [] } });
    const sid: string = made.body.scenario.id;
    ok('scenario:create: 200', made.status === 200 && made.body.ok);
    const drv = (v: number) => [{ name: '', kind: 'pct', value: v, target: { column: 'revenue' } }];
    const up = await call('scenario:update', { projectId: pid, id: sid, patch: { name: 'Price +5%', baseMetricIds: base0, drivers: drv(5) } });
    ok('scenario:update: the driver is named by the app', up.status === 200 && up.body.scenario.drivers[0].name !== '', JSON.stringify(up.body).slice(0, 200));
    const comp = await call('scenario:compute', { projectId: pid, id: sid, draft: { baseMetricIds: base0, drivers: drv(5) } });
    const rev = comp.body.metrics?.find((m: { name: string }) => m.name === 'Revenue');
    ok('scenario:compute: Revenue moves up under +5%', comp.status === 200 && comp.body.ok && rev.delta > 0 && !!comp.body.tornado, JSON.stringify(comp.body).slice(0, 300));
    const dup = await call('scenario:duplicate', { projectId: pid, id: sid });
    const sid2: string = dup.body.scenario.id;
    const tie = await call('scenario:compare', { projectId: pid, ids: [sid, sid2] });
    ok('scenario:compare: two identical scenarios → no best (a tie)', tie.status === 200 && tie.body.rows.every((r: { best: number }) => r.best === -1), JSON.stringify(tie.body.rows));
    await call('scenario:update', { projectId: pid, id: sid2, patch: { name: 'Price +10%', baseMetricIds: base0, drivers: drv(10) } });
    const cmp = await call('scenario:compare', { projectId: pid, ids: [sid, sid2] });
    const revRow = cmp.body.rows.find((r: { name: string }) => r.name === 'Revenue');
    ok('scenario:compare: Revenue (up is good) — the +10% column is best', cmp.status === 200 && revRow.best === 1, JSON.stringify(revRow));
    const tg = await call('scenario:targets', { projectId: pid, baseMetricIds: base0 });
    ok('scenario:targets: the columns these metrics aggregate', tg.status === 200 && tg.body.columns.some((c: { column: string }) => c.column === 'revenue'), JSON.stringify(tg.body).slice(0, 200));
    ok('scenario:list: both', (await call('scenario:list', { projectId: pid })).body.length === 2);
    ok('scenario:get: one', (await call('scenario:get', { projectId: pid, id: sid })).body.id === sid);
    const del = await call('scenario:delete', { projectId: pid, id: sid2 });
    ok('scenario:delete: gone', del.status === 200 && del.body.ok && (await call('scenario:list', { projectId: pid })).body.length === 1);
    ok('scenario:compare: more than four ids → 400', (await call('scenario:compare', { projectId: pid, ids: [sid, sid, sid, sid, sid] })).status === 400);

    // ── Find segments ───────────────────────────────────────────────────────
    const feat = await call('segments:features', { projectId: pid, datasetId: ds });
    ok('segments:features: number columns with a tick or a reason', feat.status === 200 && feat.body.ok && feat.body.features.length > 2, JSON.stringify(feat.body).slice(0, 200));
    const fitR = await call('segments:fit', { projectId: pid, datasetId: ds, features: ['units', 'revenue', 'profit'] });
    const r = fitR.body.result;
    const total = Math.max(1, r.total);
    ok('segments:fit: k segments', fitR.status === 200 && fitR.body.ok && r.k >= 2, JSON.stringify(fitR.body).slice(0, 200));
    ok('segments:fit: shares = size / max(1, total), the desktop\'s rule', r.sizes.every((n: number, i: number) => Object.is(fitR.body.shares.sizes[i], n / total))
      && Object.is(fitR.body.shares.empty, r.empty / total), JSON.stringify(fitR.body.shares));
    ok('segments:fit: one feature → 400', (await call('segments:fit', { projectId: pid, datasetId: ds, features: ['units'] })).status === 400);
    const col = await call('segments:saveColumn', { projectId: pid, datasetId: ds, step: { ...r.step, column: 'segment_t' } });
    ok('segments:saveColumn: a Prepare step adds the column', col.status === 200 && col.body.ok && col.body.column === 'segment_t', JSON.stringify(col.body));
    const rspec = { id: 'state', date: 'order_date', amount: 'revenue' };
    const rfm = await call('segments:rfm', { projectId: pid, datasetId: ds, spec: rspec });
    ok('segments:rfm: eleven segments, customers scored', rfm.status === 200 && rfm.body.ok && rfm.body.result.segments.length === 11 && rfm.body.result.customers > 0, JSON.stringify(rfm.body).slice(0, 200));
    const rs = await call('segments:rfmSave', { projectId: pid, datasetId: ds, spec: rspec });
    ok('segments:rfmSave: a customer-level dataset', rs.status === 200 && rs.body.ok && rs.body.dataset.rowCount === rfm.body.result.customers, JSON.stringify(rs.body));
  } finally {
    await app.close();
  }
}

/** Every channel × viewer / editor / admin grant: allowed exactly when the role reaches the access. */
async function partTwo(adminUrl: string): Promise<void> {
  const dbName = `ordinate_t210_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const app = appMod.buildApp(envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  }));
  try {
    const base = await listen(app);
    const as = (w: string) => client(base, { 'x-forwarded-email': `${w}@acme.test` });
    for (const p of ['boss', 'alice', 'bob', 'carol']) await as(p)('projects:list');
    const uid = async (w: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${w}@acme.test`])).rows[0].id;
    const boss: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const { pid, ds } = await seedSample(boss);
    for (const [w, role] of [['alice', 'viewer'], ['bob', 'editor'], ['carol', 'admin']]) {
      const r = await as('boss')('project:share', { projectId: pid, member: { userId: await uid(w) }, role });
      if (r.status !== 200) throw new Error('share ' + r.body);
    }
    const ms = (await as('boss')('scenario:metrics', { projectId: pid })).body as Array<{ id: string }>;
    const sc = (await as('boss')('scenario:create', { projectId: pid, input: { name: 'S', baseMetricIds: [ms[0].id], drivers: [] } })).body.scenario.id as string;
    const fit = (await as('boss')('segments:fit', { projectId: pid, datasetId: ds, features: ['units', 'revenue'] })).body.result;

    const calls = new Map<string, number>();
    for (const ch of Object.keys(analytics)) {
      const real = rpc.handlers.get(ch);
      if (!real) continue;
      rpc.registry.removeHandler(ch);
      rpc.registry.handle(ch, (e, ...args) => {
        calls.set(ch, (calls.get(ch) ?? 0) + 1);
        return real(e, ...args);
      });
    }
    const st = { datasetId: ds, kind: 'distribution', columns: ['revenue'] };
    const req = { datasetId: ds, metric: { column: 'revenue', aggregation: 'sum' }, compare: { mode: 'latest', column: 'order_date' } };
    const rfm = { id: 'state', date: 'order_date', amount: 'revenue' };
    let n = 0;
    const cells: Array<[string, () => unknown]> = [
      ['stats:run', () => ({ projectId: pid, spec: st })],
      ['stats:pair', () => ({ projectId: pid, spec: { ...st, kind: 'correlation' }, x: 'units', y: 'revenue' })],
      ['stats:saveFormula', () => ({ projectId: pid, spec: { datasetId: ds, kind: 'regression', target: 'profit', predictors: ['units'] } })],
      ['stats:addToDashboard', () => ({ projectId: pid, spec: st, view: 'table', name: 'D' })],
      ['stats:dashboards', () => ({ projectId: pid })],
      ['drivers:explain', () => ({ projectId: pid, request: req })],
      ['drivers:addTile', () => ({ projectId: pid, request: { ...req, dimension: 'region' }, name: 'W' })],
      ['scenario:list', () => ({ projectId: pid })],
      ['scenario:get', () => ({ projectId: pid, id: sc })],
      ['scenario:create', () => ({ projectId: pid, input: { name: 'N', baseMetricIds: [], drivers: [] } })],
      ['scenario:update', () => ({ projectId: pid, id: sc, patch: { baseMetricIds: [ms[0].id], drivers: [] } })],
      ['scenario:duplicate', () => ({ projectId: pid, id: sc })],
      ['scenario:compute', () => ({ projectId: pid, id: sc, draft: { baseMetricIds: [ms[0].id], drivers: [] } })],
      ['scenario:compare', () => ({ projectId: pid, ids: [sc] })],
      ['scenario:targets', () => ({ projectId: pid, baseMetricIds: [ms[0].id] })],
      ['scenario:metrics', () => ({ projectId: pid })],
      ['segments:features', () => ({ projectId: pid, datasetId: ds })],
      ['segments:fit', () => ({ projectId: pid, datasetId: ds, features: ['units', 'revenue'] })],
      ['segments:saveColumn', () => ({ projectId: pid, datasetId: ds, step: { ...fit.step, column: `seg_${++n}` } })],
      ['segments:rfm', () => ({ projectId: pid, datasetId: ds, spec: rfm })],
      ['segments:rfmSave', () => ({ projectId: pid, datasetId: ds, spec: rfm })],
      // Last: it removes what the others read.
      ['scenario:delete', () => ({ projectId: pid, id: sc })],
    ];
    const rank = { read: 1, write: 2, admin: 3 } as const;
    const has: Record<string, number> = { alice: 1, bob: 2, carol: 3 };
    let wrong = 0;
    let leaks = 0;
    const lines: string[] = [];
    const covered = new Set(cells.map((c) => c[0]));
    ok('roles: the matrix covers every analytics channel', Object.keys(analytics).every((c) => covered.has(c)), Object.keys(analytics).filter((c) => !covered.has(c)).join());
    for (const [ch, mk] of cells) {
      const access = (analytics as Record<string, { access: 'read' | 'write' | 'admin' }>)[ch].access;
      const line: string[] = [];
      for (const w of ['alice', 'bob', 'carol']) {
        const before = calls.get(ch) ?? 0;
        const r = await as(w)(ch, mk());
        const allowed = r.status === 200;
        if (allowed !== has[w] >= rank[access] || (r.status !== 200 && r.status !== 403)) wrong++;
        if (!allowed && (calls.get(ch) ?? 0) !== before) leaks++;
        line.push(allowed ? 'ALLOW' : 'deny ');
      }
      lines.push(`     ${ch.padEnd(22)} ${access.padEnd(6)} ${line.join(' ')}`);
    }
    console.log('     channel                access viewer editor admin\n' + lines.join('\n'));
    ok('roles: every channel allows exactly the roles its access names', wrong === 0, wrong);
    ok('roles: a denied call never reached its handler (spy)', leaks === 0, leaks);
  } finally {
    await app.close();
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  try {
    await partOne();
    if (process.env.DATABASE_URL) await partTwo(process.env.DATABASE_URL);
    else console.log('skip analytics DB part: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);

