// Analyses, authoring and metrics over the server's RPC (T2.8) — real HTTP,
// server mode, no Electron.
//
//   Part 1 (always): dev sign-in, records as files.
//     analysis:gallery   each card's previews are the first sheet's first two
//                        visuals, exactly as the store holds them; a dangling
//                        visualId is skipped, never a crash
//     analysis:open      the analysis as the store reads it + every visual
//     analysis:tiles     DIFFERENTIAL: every tile Object.is-equal to the single
//                        handler it batches (visual:data, dashboard:metric,
//                        metric:value, metric:compare); the sheet's parameters
//                        (an array) reach the chart's filters
//     metric:table       value / series / usage equal the single handlers'
//     metric:values      equal metric:value
//     CRUD               create → update (whole-array replace) → rename →
//                        delete to Trash → restore; 400 / 403 at the edge
//   Part 2 (DATABASE_URL): header sign-in on a scratch database. Every new
//     channel by project role (viewer / editor / org admin) — a denied call
//     never reaches its handler.
//
//   npm run build:ts && node scripts/test-analysesServer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: the loader hook has no public type

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const api: typeof import('../src/api/index') = require('../src/api/index');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const usageMod: typeof import('../src/analysis/metricUsage') = require('../src/analysis/metricUsage');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-analyses-'));
type Identity = import('../src/server/context').Identity;
// any: each channel's own reply shape
type Reply = { status: number; body: any };

const SALES = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' as const }] };

/** A project's records, written through the stores as `who`. */
async function seed(who: Identity, projectId: string) {
  return context.runInContext(who, 'seed', async () => {
    const rows: Array<[string, string, number]> = [];
    const regions = ['North', 'South', 'East', 'West'];
    for (let m = 1; m <= 12; m++) {
      for (const [i, r] of regions.entries()) rows.push([r, `2025-${String(m).padStart(2, '0')}-15`, m * 10 + i + 0.25]);
    }
    const d = await datasets.saveDataset(projectId, {
      name: 'Orders', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }],
      rows,
    });
    if (!d) throw new Error('seed dataset');
    const mk = async (name: string, chartType: string, filters: unknown[] = []) => {
      const v = await visuals.saveVisual(projectId, { name, datasetId: d.id, chartType, encoding: SALES, filters } as never);
      if (!v) throw new Error('seed visual');
      return v.id;
    };
    const v1 = await mk('Sales by region', 'bar');
    const v2 = await mk('Big orders', 'column', [{ type: 'filter', column: 'amount', op: '>', value: '[[min]]' }]);
    const v3 = await mk('Third', 'line');
    const rev = await metrics.saveMetric(projectId, { name: 'Revenue', datasetId: d.id, definition: { column: 'amount', aggregation: 'sum' }, format: { kind: 'currency', decimals: 0 } } as never);
    const avg = await metrics.saveMetric(projectId, { name: 'Per order', datasetId: d.id, definition: { formula: '[Revenue] / 48' } } as never);
    if (!rev || !avg) throw new Error('seed metric');
    const ghost = '00000000-0000-4000-8000-000000000000';
    const card = (type: string, x: number, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x, y: 0, w: 3, h: 4 }, ...extra });
    const a = await analysis.saveAnalysis(projectId, {
      name: 'Board',
      sheets: [
        {
          name: 'Overview',
          cards: [
            card('text', 0, { heading: 'Hello' }),
            card('visual', 3, { visualId: ghost }),
            card('visual', 6, { visualId: v1 }),
            card('metric', 0, { metric: { datasetId: d.id, column: 'amount', aggregation: 'sum', metricId: rev.id } }),
            card('visual', 9, { visualId: v2 }),
            card('visual', 0, { visualId: v3 }),
          ],
        },
        { name: 'Second', cards: [] },
      ],
    });
    const empty = await analysis.saveAnalysis(projectId, { name: 'Empty' });
    if (!a || !empty) throw new Error('seed analysis');
    return { ds: d.id, v1, v2, v3, rev: rev.id, avg: avg.id, aid: a.id, empty: empty.id };
  });
}

function client(base: string, headers: Record<string, string> = {}) {
  const call = async (channel: string, payload?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json', ...headers }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
  };
  return { call };
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
}

/** Deep equality with Object.is at every leaf (NaN, -0 and null kept apart). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.join() === kb.join() && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

async function partOne(): Promise<void> {
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }));
  const base = await listen(app);
  const { call } = client(base);
  const dev: Identity = { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
  /** The single handler, called as the RPC layer would — the reference for every batch. */
  const direct = (channel: string, payload: unknown) =>
    context.runInContext(dev, 'direct', async () => (rpc.handlers.get(channel) as import('../src/server/rpc').Handler)({}, payload)) as Promise<any>; // any: a handler's reply
  try {
    const pid: string = (await call('projects:create', { name: 'Dashboards' })).body.id;
    const s = await seed(dev, pid);

    // ── analysis:gallery ──────────────────────────────────────────────────
    const g = await call('analysis:gallery', { projectId: pid });
    const board = g.body.find((x: { id: string }) => x.id === s.aid);
    const emptyRow = g.body.find((x: { id: string }) => x.id === s.empty);
    const want = await context.runInContext(dev, 'v', async () => [await visuals.getVisual(pid, s.v1), await visuals.getVisual(pid, s.v2)]);
    ok('gallery: 200, both dashboards, newest first', g.status === 200 && g.body.length === 2 && g.body[0].id === s.empty, JSON.stringify(g.body.map((x: { name: string }) => x.name)));
    ok('gallery: previews = the first sheet\'s first two RESOLVABLE visuals (the dangling one skipped)',
      board.previews.map((p: { id: string }) => p.id).join() === [s.v1, s.v2].join(), JSON.stringify(board.previews.map((p: { name: string }) => p.name)));
    ok('gallery: a preview carries the store\'s definition, field for field',
      board.previews.every((p: any, i: number) => same(p.encoding, want[i]?.encoding) && same(p.filters, want[i]?.filters) && p.chartType === want[i]?.chartType && p.datasetId === s.ds), // any: a reply row
      JSON.stringify(board.previews[1]));
    ok('gallery: sheetCount from the record; an empty dashboard has no previews', board.sheetCount === 2 && emptyRow.previews.length === 0);

    // ── analysis:open ─────────────────────────────────────────────────────
    const op = await call('analysis:open', { projectId: pid, id: s.aid });
    const stored = await context.runInContext(dev, 'a', () => analysis.getAnalysis(pid, s.aid));
    ok('open: the analysis exactly as the store reads it', op.status === 200 && op.body.ok && same(op.body.analysis, stored));
    ok('open: every visual of the project, with its definition', op.body.visuals.length === 3 && op.body.visuals.every((v: { encoding: unknown }) => same(v.encoding, SALES)));
    const gone = await call('analysis:open', { projectId: pid, id: '00000000-0000-4000-8000-000000000001' });
    ok('open: an unknown dashboard is a refusal with a reason, not a 500', gone.status === 200 && gone.body.ok === false && typeof gone.body.error === 'string');

    // ── analysis:tiles — differential against the single handlers ─────────
    const scope = [{ type: 'filter', column: 'region', op: 'in', values: ['North', 'East'] }];
    const params = [{ name: 'min', kind: 'number', value: 100 }];
    const items = [
      { kind: 'visual', datasetId: s.ds, encoding: SALES, filters: scope },
      { kind: 'visual', datasetId: s.ds, encoding: SALES, filters: [{ type: 'filter', column: 'amount', op: '>', value: '[[min]]' }] },
      { kind: 'metric', datasetId: s.ds, column: 'amount', aggregation: 'avg', filters: scope },
      { kind: 'metric', datasetId: s.ds, column: 'amount', aggregation: 'sum', metricId: s.rev, filters: scope },
      { kind: 'metric', datasetId: s.ds, column: '', aggregation: 'sum', metricId: s.avg },
      { kind: 'metric', datasetId: s.ds, column: 'amount', aggregation: 'sum', metricId: '00000000-0000-4000-8000-000000000002' },
      {
        kind: 'metric', datasetId: s.ds, column: 'amount', aggregation: 'sum', metricId: s.rev,
        filters: [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2025-06-01', to: '2025-06-30' } }],
        compare: { mode: 'previous_period' },
      },
    ];
    const t = await call('analysis:tiles', { projectId: pid, params, items });
    ok('tiles: 200, one answer per item, in order', t.status === 200 && t.body.length === items.length, t.status === 200 ? '' : t.body);
    const v0 = await direct('visual:data', { projectId: pid, datasetId: s.ds, encoding: SALES, filters: scope, params });
    ok('tiles: a chart tile IS visual:data\'s reply (Object.is at every leaf)', same(t.body[0], v0), JSON.stringify(t.body[0]).slice(0, 200));
    const vp = await direct('visual:data', { projectId: pid, datasetId: s.ds, encoding: SALES, filters: items[1].filters, params });
    const vNo = await direct('visual:data', { projectId: pid, datasetId: s.ds, encoding: SALES, filters: items[1].filters });
    ok('tiles: the sheet\'s parameters reach the chart (equal to visual:data WITH them, not without)',
      same(t.body[1], vp) && !same(t.body[1], vNo), JSON.stringify([t.body[1].data?.series, vNo.data?.series]).slice(0, 300));
    const m0 = await direct('dashboard:metric', { projectId: pid, datasetId: s.ds, column: 'amount', aggregation: 'avg', filters: scope, params });
    ok('tiles: a column KPI is dashboard:metric\'s figure', t.body[2].ok && Object.is(t.body[2].value, m0.value) && t.body[2].display === undefined, JSON.stringify([t.body[2], m0]));
    const mv = await direct('metric:value', { projectId: pid, id: s.rev, filters: scope, params });
    ok('tiles: a KPI naming a saved metric shows metric:value\'s figure AND its display string',
      Object.is(t.body[3].value, mv.value) && t.body[3].display === mv.display && t.body[3].name === 'Revenue', JSON.stringify([t.body[3], mv.display]));
    const mf = await direct('metric:value', { projectId: pid, id: s.avg, params });
    ok('tiles: a FORMULA metric (no column) resolves through the metric', Object.is(t.body[4].value, mf.value) && t.body[4].display === mf.display, JSON.stringify(t.body[4]));
    const fall = await direct('dashboard:metric', { projectId: pid, datasetId: s.ds, column: 'amount', aggregation: 'sum', params });
    ok('tiles: a deleted metric falls back to the card\'s own column', t.body[5].ok && Object.is(t.body[5].value, fall.value) && t.body[5].display === undefined, JSON.stringify(t.body[5]));
    const cmp = await direct('metric:compare', {
      projectId: pid, card: { metricId: s.rev, datasetId: s.ds, column: 'amount', aggregation: 'sum' }, filters: items[6].filters, compare: { mode: 'previous_period' }, params,
    });
    ok('tiles: a compare IS metric:compare\'s reply', same(t.body[6].compare, cmp) && typeof cmp.delta === 'number', JSON.stringify(t.body[6].compare));
    ok('tiles: an unknown kind is a 400 naming the path', (await call('analysis:tiles', { projectId: pid, items: [{ kind: 'map' }] })).status === 400);
    ok('tiles: an empty batch is a 400', (await call('analysis:tiles', { projectId: pid, items: [] })).status === 400);

    // ── metric:table / metric:values ──────────────────────────────────────
    const mt = await call('metric:table', { projectId: pid });
    const listed = await direct('metric:list', { projectId: pid });
    ok('metric:table: the list IS metric:list\'s', mt.status === 200 && same(mt.body.metrics, listed.metrics));
    let cellsOk = true;
    for (const m of listed.metrics) {
      const v = await direct('metric:value', { projectId: pid, id: m.id });
      const sr = await direct('metric:series', { projectId: pid, id: m.id });
      const us = await context.runInContext(dev, 'u', () => usageMod.metricUsage(pid, m.id));
      const row = mt.body.rows[m.id];
      if (!(row.display === v.display && same(row.series, sr.series ? sr.series.values : null) && same(row.usage, us))) cellsOk = false;
    }
    ok('metric:table: every row\'s value, series and usage equal the single handlers\'', cellsOk, JSON.stringify(mt.body.rows));
    ok('metric:table: Revenue is used by the dashboard\'s KPI', mt.body.rows[s.rev].usage.total >= 1, JSON.stringify(mt.body.rows[s.rev].usage));
    const vals = await call('metric:values', { projectId: pid, ids: [s.rev, s.avg], filters: scope });
    const r1 = await direct('metric:value', { projectId: pid, id: s.rev, filters: scope });
    ok('metric:values: equal metric:value, in order', vals.status === 200 && vals.body[0].id === s.rev && Object.is(vals.body[0].value, r1.value) && vals.body[0].display === r1.display && vals.body[1].ok);

    // ── CRUD at the edge ──────────────────────────────────────────────────
    const made = await call('analysis:create', { projectId: pid, name: '  Fresh  ' });
    ok('create: a new dashboard with one empty sheet, the name trimmed', made.status === 200 && made.body.name === 'Fresh' && made.body.sheets.length === 1, JSON.stringify(made.body));
    const sheet = { id: made.body.sheets[0].id, name: 'Main', cards: [{ id: crypto.randomUUID(), type: 'text', layout: { x: 0, y: 0, w: 14, h: 2 }, text: 'Hi' }] };
    const up = await call('analysis:update', { projectId: pid, id: made.body.id, sheets: [sheet], parameters: [{ name: 'min', kind: 'number', value: 5 }] });
    ok('update: the sheets REPLACE the stored ones; an over-wide layout is clamped by the store', up.body.ok && up.body.analysis.sheets.length === 1
      && up.body.analysis.sheets[0].name === 'Main' && up.body.analysis.sheets[0].cards[0].layout.w === 12 && up.body.analysis.parameters[0].name === 'min', JSON.stringify(up.body.analysis?.sheets));
    const rn = await call('analysis:rename', { projectId: pid, id: made.body.id, name: 'Renamed' });
    ok('rename: ok', rn.body.ok && rn.body.analysis.name === 'Renamed');
    const del = await call('analysis:delete', { projectId: pid, id: made.body.id });
    const inTrash = (await call('trash:list', { projectId: pid })).body;
    ok('delete: to the Trash (restorable), gone from the gallery', del.body.ok && JSON.stringify(inTrash).includes(made.body.id)
      && !(await call('analysis:gallery', { projectId: pid })).body.some((x: { id: string }) => x.id === made.body.id), JSON.stringify(del.body));
    ok('edge: a non-UUID project is a 400', (await call('analysis:gallery', { projectId: 'nope' })).status === 400);
    ok('edge: an unknown project is a 403 before the handler', (await call('analysis:gallery', { projectId: '00000000-0000-4000-8000-0000000000aa' })).status === 403);
    ok('edge: an unknown field is a 400 (strict)', (await call('analysis:update', { projectId: pid, id: s.aid, views: [] })).status === 400);
    ok('edge: analysis:list / analysis:get stay uncontracted (404)', (await call('analysis:list', { projectId: pid })).status === 404
      && (await call('analysis:get', { projectId: pid, id: s.aid })).status === 404);

    // Metric CRUD.
    const ms = await call('metric:save', { projectId: pid, input: { name: 'Orders', datasetId: s.ds, definition: { column: 'amount', aggregation: 'count' } } });
    ok('metric:save: ok', ms.body.ok && ms.body.metric.name === 'Orders', JSON.stringify(ms.body));
    const dup = await call('metric:save', { projectId: pid, input: { name: 'orders', datasetId: s.ds, definition: { column: 'amount', aggregation: 'sum' } } });
    ok('metric:save: a duplicate name is refused with a reason', dup.body.ok === false && /already exists/.test(dup.body.error));
    const pv = await call('metric:preview', { projectId: pid, datasetId: s.ds, definition: { column: 'amount', aggregation: 'count' } });
    ok('metric:preview: the count of 48 rows, with the server\'s display', pv.body.ok && pv.body.value === 48 && pv.body.display === '48', JSON.stringify(pv.body));
    const mu = await call('metric:update', { projectId: pid, id: ms.body.metric.id, patch: { name: 'Order count', direction: 'up_good' } });
    ok('metric:update: ok', mu.body.ok && mu.body.metric.name === 'Order count' && mu.body.metric.direction === 'up_good');
    const md = await call('metric:delete', { projectId: pid, id: ms.body.metric.id });
    ok('metric:delete: to the Trash', md.body.ok && JSON.stringify((await call('trash:list', { projectId: pid })).body).includes(ms.body.metric.id));
  } finally {
    await app.close();
  }
}

async function partTwo(adminUrl: string): Promise<void> {
  const dbName = `ordinate_t28_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  const app = appMod.buildApp(envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  }));
  try {
    const base = await listen(app);
    const as = (who: string) => client(base, { 'x-forwarded-email': `${who}@acme.test` });
    for (const p of ['boss', 'alice', 'bob']) await as(p).call('projects:list');
    const uid = async (who: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${who}@acme.test`])).rows[0].id;
    const boss = as('boss');
    const pid: string = (await boss.call('projects:create', { name: 'Shared' })).body.id;
    for (const [who, role] of [['alice', 'viewer'], ['bob', 'editor']]) {
      await boss.call('project:share', { projectId: pid, member: { userId: await uid(who) }, role });
    }
    const bossId: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const s = await seed(bossId, pid);

    const calls = new Map<string, number>();
    for (const ch of Object.keys(api.contracts)) {
      const real = rpc.handlers.get(ch);
      if (!real) continue;
      rpc.registry.removeHandler(ch);
      rpc.registry.handle(ch, (e, ...args) => {
        calls.set(ch, (calls.get(ch) ?? 0) + 1);
        return real(e, ...args);
      });
    }
    const plan = { name: 'Planned', sheets: [{ name: 'One', visuals: [{ datasetId: s.ds, name: 'By region', chartType: 'bar', encoding: SALES }] }] };
    type Cell = [string, () => unknown, 'read' | 'write'];
    const cells: Cell[] = [
      ['analysis:gallery', () => ({ projectId: pid }), 'read'],
      ['analysis:open', () => ({ projectId: pid, id: s.aid }), 'read'],
      ['analysis:tiles', () => ({ projectId: pid, items: [{ kind: 'metric', datasetId: s.ds, column: 'amount', aggregation: 'sum' }] }), 'read'],
      ['analysis:previewPlan', () => ({ projectId: pid, plan }), 'read'],
      ['template:list', () => ({ projectId: pid, datasetId: s.ds }), 'read'],
      ['dashboard:metric', () => ({ projectId: pid, datasetId: s.ds, column: 'amount', aggregation: 'sum' }), 'read'],
      ['metric:list', () => ({ projectId: pid }), 'read'],
      ['metric:get', () => ({ projectId: pid, id: s.rev }), 'read'],
      ['metric:table', () => ({ projectId: pid }), 'read'],
      ['metric:values', () => ({ projectId: pid, ids: [s.rev] }), 'read'],
      ['metric:preview', () => ({ projectId: pid, datasetId: s.ds, definition: { column: 'amount', aggregation: 'sum' } }), 'read'],
      ['analysis:create', () => ({ projectId: pid, name: 'New' }), 'write'],
      ['analysis:update', () => ({ projectId: pid, id: s.aid, name: 'Board' }), 'write'],
      ['analysis:rename', () => ({ projectId: pid, id: s.aid, name: 'Board' }), 'write'],
      ['analysis:buildPlan', () => ({ projectId: pid, plan }), 'write'],
      ['analysis:starterCards', () => ({ projectId: pid, kind: 'kpis', datasetId: s.ds }), 'write'],
      ['metric:ensureDefaults', () => ({ projectId: pid }), 'write'],
      ['metric:duplicate', () => ({ projectId: pid, id: s.rev }), 'write'],
      ['analysis:delete', () => ({ projectId: pid, id: s.empty }), 'write'],
    ];
    const rank = { read: 1, write: 2 } as const;
    const has: Record<string, number> = { alice: 1, bob: 2, boss: 3 };
    let wrong = 0;
    let leaks = 0;
    const lines: string[] = [];
    for (const [ch, mk, access] of cells) {
      const line: string[] = [];
      for (const who of ['alice', 'bob', 'boss']) {
        const n = calls.get(ch) ?? 0;
        const r = await as(who).call(ch, mk());
        const allowed = r.status === 200;
        if (allowed !== has[who] >= rank[access] || (r.status !== 200 && r.status !== 403)) wrong++;
        if (!allowed && (calls.get(ch) ?? 0) !== n) leaks++;
        line.push(allowed ? 'ALLOW' : 'deny ');
      }
      lines.push(`     ${ch.padEnd(22)} ${access.padEnd(6)} ${line.join(' ')}`);
    }
    console.log('     channel                access viewer editor org-admin\n' + lines.join('\n'));
    ok('roles: every T2.8 channel allows exactly the roles its access names', wrong === 0, wrong);
    ok('roles: a denied call never reached its handler (spy)', leaks === 0, leaks);
    const audit = await pool.query<{ channel: string }>(`SELECT channel FROM audit_log WHERE outcome = 'ok' AND channel IN ('analysis:update', 'metric:duplicate')`);
    ok('audit: writes are on the trail', audit.rows.length >= 2, JSON.stringify(audit.rows));
  } finally {
    await app.close().catch(() => undefined);
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
    else console.log('skip analyses DB part: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
