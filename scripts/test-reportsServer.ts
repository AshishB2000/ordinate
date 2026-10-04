// Reports, stories and scorecards over the server's RPC (T2.13) — real HTTP,
// server mode, no Electron.
//
//   Part 1 (always): dev sign-in, records as files.
//     report:preview    DIFFERENTIAL: every chart on a page IS visual:data's
//                       reply on the share path 'report' under the dashboard's
//                       as-saved scope; every caption IS reports:caption's;
//                       every KPI is analysis:tiles' figure — Object.is
//     share policy      a column marked sensitive with report = drop hides the
//                       tile (keeps its place, says why) and the reply carries
//                       the policy line
//     story:figures     equal visual:data (NOT shaped — on screen) and metric:value
//     story:export      a page per heading; charts on the share path
//     scorecard:compute the new display strings and tallies follow the figures
//     paths             no local path in any reply; the path channels are 404
//   Part 2 (DATABASE_URL): header sign-in on a scratch database — every new
//     channel by project role; a denied call never reaches its handler; the
//     two exports are on the audit trail.
//
//   npm run build:ts && node scripts/test-reportsServer.js

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
const reportSpec: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
const savedViews: typeof import('../src/analysis/savedViews') = require('../src/analysis/savedViews');
const dashFilters: typeof import('../src/analysis/dashboardFilters') = require('../src/analysis/dashboardFilters');
const sharePolicy: typeof import('../src/app/sharePolicy') = require('../src/app/sharePolicy');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-reports-'));
type Identity = import('../src/server/context').Identity;
type Reply = { status: number; body: any }; // any: each channel's own reply shape

const SALES = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' as const }] };
const BY_DAY = { category: 'day', values: [{ column: 'amount', aggregation: 'sum' as const }], grain: 'month' };

async function seed(who: Identity, projectId: string) {
  return context.runInContext(who, 'seed', async () => {
    const rows: Array<[string, string, number]> = [];
    const regions = ['North', 'South', 'East', 'West'];
    for (let m = 1; m <= 12; m++) for (const [i, r] of regions.entries()) rows.push([r, `2025-${String(m).padStart(2, '0')}-15`, m * 10 + i + 0.25]);
    const d = await datasets.saveDataset(projectId, {
      name: 'Orders', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }],
      rows,
    });
    if (!d) throw new Error('seed dataset');
    const v1 = await visuals.saveVisual(projectId, { name: 'Sales by region', datasetId: d.id, chartType: 'bar', encoding: SALES, filters: [] } as never);
    const v2 = await visuals.saveVisual(projectId, { name: 'Monthly', datasetId: d.id, chartType: 'line', encoding: BY_DAY, filters: [{ type: 'filter', column: 'amount', op: '>', value: 20 }] } as never);
    const rev = await metrics.saveMetric(projectId, { name: 'Revenue', datasetId: d.id, definition: { column: 'amount', aggregation: 'sum' }, format: { kind: 'currency', decimals: 0 }, direction: 'up_good' } as never);
    if (!v1 || !v2 || !rev) throw new Error('seed visual / metric');
    const card = (type: string, x: number, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x, y: 0, w: 3, h: 4 }, ...extra });
    const control = card('control', 0, { control: { kind: 'multi', label: 'Region', datasetId: d.id, column: 'region', default: { values: ['North', 'East', 'West'] } } });
    const tile1 = card('visual', 3, { visualId: v1.id });
    const a = await analysis.saveAnalysis(projectId, {
      name: 'Board',
      sheets: [
        { name: 'Overview', cards: [control, tile1, card('metric', 0, { metric: { datasetId: d.id, column: 'amount', aggregation: 'avg', label: 'Avg order' } }), card('metric', 6, { metric: { datasetId: d.id, column: 'amount', aggregation: 'sum', metricId: rev.id } })] },
        { name: 'Trend', cards: [card('visual', 0, { visualId: v2.id }), card('text', 6, { heading: 'Note', text: 'Hello' })] },
      ],
    });
    if (!a) throw new Error('seed analysis');
    return { ds: d.id, v1: v1.id, v2: v2.id, rev: rev.id, aid: a.id, tile1: tile1.id };
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
  const direct = (channel: string, payload: unknown) =>
    context.runInContext(dev, 'direct', async () => (rpc.handlers.get(channel) as import('../src/server/rpc').Handler)({}, payload)) as Promise<any>; // any: a handler's reply
  try {
    const pid: string = (await call('projects:create', { name: 'Reports' })).body.id;
    const s = await seed(dev, pid);

    // ── reports CRUD + open ───────────────────────────────────────────────
    const made = await call('reports:create', { projectId: pid, analysisId: s.aid });
    ok('reports:create: a report from the dashboard, its pages built by the server', made.status === 200 && made.body.ok && made.body.report.pages.length >= 3, JSON.stringify(made.body).slice(0, 300));
    const rid: string = made.body.report.id;
    const list = await call('reports:list', { projectId: pid });
    ok('reports:list: the new report', list.status === 200 && list.body.length === 1 && list.body[0].id === rid);
    const op = await call('reports:open', { projectId: pid, id: rid });
    ok('reports:open: the sheets and their visual cards by NAME, the dashboard named', op.body.ok && op.body.sheets.length === 2
      && op.body.sheets[0].cards[0].name === 'Sales by region' && op.body.dashboard.name === 'Board', JSON.stringify(op.body.sheets));

    // ── report:preview — differential ─────────────────────────────────────
    const pages = [
      { id: crypto.randomUUID(), kind: 'cover', include: true, layout: 'full' },
      { id: crypto.randomUUID(), kind: 'summary', include: true, layout: 'full' },
      { id: crypto.randomUUID(), kind: 'sheet', sheetIdx: 0, include: true, layout: 'full' },
      { id: crypto.randomUUID(), kind: 'tile', cardId: s.tile1, include: true, layout: 'full' },
      { id: crypto.randomUUID(), kind: 'notes', notes: 'Read me', include: true, layout: 'full' },
      { id: crypto.randomUUID(), kind: 'tile', cardId: crypto.randomUUID(), include: true, layout: 'full' },
      { id: crypto.randomUUID(), kind: 'notes', notes: 'skipped', include: false, layout: 'full' },
    ];
    const pv = await call('report:preview', { projectId: pid, id: rid, draft: { pages, name: 'Draft name' } });
    ok('preview: 200, the unsaved draft\'s included pages in order', pv.status === 200 && pv.body.ok
      && pv.body.pages.map((p: { kind: string }) => p.kind).join() === 'cover,summary,sheet,tile,notes,tile', JSON.stringify(pv.body).slice(0, 300));
    const a = await context.runInContext(dev, 'a', () => analysis.getAnalysis(pid, s.aid));
    const scope = savedViews.viewScope(null, a as never);
    const v1 = await context.runInContext(dev, 'v', () => visuals.getVisual(pid, s.v1));
    const want = await direct('visual:data', { projectId: pid, datasetId: s.ds, encoding: v1!.encoding, filters: dashFilters.mergeDashboardFilters(scope.filters, v1!.filters), params: scope.params, share: 'report' });
    const tile = pv.body.pages[3];
    ok('preview: a tile\'s chart IS visual:data on the share path, under the dashboard\'s saved scope (control defaults applied)',
      same(tile.chart.data, want.data) && tile.chart.type === 'bar' && want.data.labels.length === 3, JSON.stringify([tile.chart.data.labels, want.data.labels]));
    const cap = await direct('reports:caption', { input: { chartType: 'bar', data: want.data, geo: null, pivot: null, projectId: pid, datasetId: s.ds, overrides: v1!.overrides || null } });
    ok('preview: the tile\'s caption IS reports:caption\'s sentence', tile.caption === cap && cap.length > 0, JSON.stringify([tile.caption, cap]));
    const sheet = pv.body.pages[2];
    const avg = await direct('dashboard:metric', { projectId: pid, datasetId: s.ds, column: 'amount', aggregation: 'avg', filters: scope.filters, params: scope.params });
    const revv = await direct('metric:value', { projectId: pid, id: s.rev, filters: scope.filters, params: scope.params });
    const fmt: typeof import('../src/app/format') = require('../src/app/format');
    ok('preview: a column KPI is dashboard:metric\'s figure, formatted by the server', sheet.kpis[0].label === 'Avg order' && sheet.kpis[0].value === fmt.formatValue(avg.value, 'auto'), JSON.stringify([sheet.kpis, avg.value]));
    ok('preview: a saved-metric KPI shows metric:value\'s own display string', sheet.kpis[1].value === revv.display && sheet.kpis[1].label === 'Revenue', JSON.stringify([sheet.kpis[1], revv.display]));
    ok('preview: a sheet page carries its tiles as charts', sheet.tiles.length === 1 && same(sheet.tiles[0].chart.data, want.data));
    const kcap = await direct('reports:caption', { input: { kpis: [{ label: 'Avg order', value: avg.value }, { label: 'Revenue', value: revv.value }] } });
    ok('preview: the sheet caption IS the KPI sentence', sheet.caption === kcap, JSON.stringify([sheet.caption, kcap]));
    ok('preview: the summary lists the KPIs and every tile\'s sentence', pv.body.pages[1].kpis.length === 2 && pv.body.pages[1].bullets.some((b: string) => b.startsWith('Sales by region — ')), JSON.stringify(pv.body.pages[1]));
    ok('preview: the cover names the date and the dashboard\'s filter line; the mark is Ordinate\'s', pv.body.pages[0].meta.length >= 2
      && pv.body.pages[0].meta[1] === 'Filtered: Region = North, East, West' && pv.body.pages[0].logo === 'mark', JSON.stringify(pv.body.pages[0]));
    ok('preview: a card removed from the dashboard keeps its page and says so', pv.body.pages[5].body === 'This tile is no longer on the dashboard.');
    const one = await call('report:preview', { projectId: pid, id: rid, draft: { pages }, page: 3 });
    ok('preview: page=3 resolves only that page', one.body.pages.length === 1 && one.body.pages[0].kind === 'tile' && same(one.body.pages[0].chart.data, want.data));
    const stored = await context.runInContext(dev, 'r', () => reportSpec.getReport(pid, rid));
    ok('preview: a draft is never saved', stored!.name !== 'Draft name' && stored!.pages.length !== pages.length);

    // ── the Share policy decides what leaves ──────────────────────────────
    await call('privacy:decide', { projectId: pid, datasetId: s.ds, column: 'region', level: 'personal' });
    await call('privacy:setPolicy', { projectId: pid, policy: { report: 'drop' } });
    const hid = await call('report:build', { projectId: pid, id: rid });
    const tileHidden = hid.body.pages.find((p: { kind: string }) => p.kind === 'sheet').tiles[0];
    ok('share: drop hides the tile — no chart, the policy\'s words — and keeps its place', tileHidden && tileHidden.chart === null && tileHidden.note === sharePolicy.HIDDEN_BY_POLICY, JSON.stringify(tileHidden));
    ok('share: the reply carries the policy line for the browser to show', hid.body.share && hid.body.share.action === 'drop' && hid.body.share.count >= 1 && typeof hid.body.share.line === 'string', JSON.stringify(hid.body.share));

    // ── stories ───────────────────────────────────────────────────────────
    const st = await call('story:create', { projectId: pid, name: 'Q3 story' });
    ok('story:create', st.status === 200 && st.body.id, JSON.stringify(st.body));
    const blocks = [
      { id: 'h1', kind: 'text', text: '# Revenue\nIt grew.' },
      { id: 'b1', kind: 'visual', visualId: s.v1, filters: [{ type: 'filter', column: 'region', op: '!=', value: 'South' }] },
      { id: 'b2', kind: 'metrics_row', metricIds: [s.rev], filters: [] },
      { id: 'h2', kind: 'text', text: '## Next\nMore.' },
      { id: 'b3', kind: 'metric', metricId: s.rev, filters: [] },
    ];
    const up = await call('story:update', { projectId: pid, id: st.body.id, blocks });
    ok('story:update: the blocks saved as sanitized', up.body.id && up.body.blocks.length === 5, JSON.stringify(up.body).slice(0, 200));
    const figs = await call('story:figures', { projectId: pid, blocks: blocks.filter((b) => b.kind !== 'text') });
    const plain = await direct('visual:data', { projectId: pid, datasetId: s.ds, encoding: SALES, filters: dashFilters.mergeDashboardFilters(blocks[1].filters as never, []), params: [] });
    ok('story:figures: on screen the chart is visual:data UNshaped (the policy is for what leaves)', same(figs.body.blocks.b1.chart.data, plain.data) && plain.data.labels.length === 3, JSON.stringify(figs.body.blocks.b1).slice(0, 200));
    const mv = await direct('metric:value', { projectId: pid, id: s.rev, filters: [] });
    ok('story:figures: a metric is metric:value\'s name and display', figs.body.blocks.b2.figures[0].display === mv.display && figs.body.blocks.b3.figures[0].name === 'Revenue');
    ok('story:figures: a single metric carries its KPI sentence; a row none', typeof figs.body.blocks.b3.caption === 'string' && figs.body.blocks.b3.caption.length > 0 && figs.body.blocks.b2.caption === '');
    const ex = await call('story:export', { projectId: pid, id: st.body.id });
    ok('story:export: a page per heading, prose, KPIs and the chart', ex.body.ok && ex.body.pages.length === 2 && ex.body.pages[0].title === 'Revenue'
      && ex.body.pages[0].body === 'It grew.' && ex.body.pages[0].kpis[0].value === mv.display, JSON.stringify(ex.body.pages).slice(0, 400));
    ok('story:export: the chart is on the share path (hidden by the drop policy)', ex.body.pages[0].chart === null && ex.body.pages[0].note === sharePolicy.HIDDEN_BY_POLICY && ex.body.share);
    await call('privacy:setPolicy', { projectId: pid, policy: { report: 'mask' } });

    // ── scorecards ────────────────────────────────────────────────────────
    const sc = await call('scorecard:create', { projectId: pid, name: 'Monthly', period: 'month', rows: [{ metricId: s.rev, target: 100, group: 'Sales' }] });
    ok('scorecard:create', sc.body.ok, JSON.stringify(sc.body));
    const cmp = await call('scorecard:compute', { projectId: pid, id: sc.body.scorecard.id });
    const row = cmp.body.rows[0];
    const scMod: typeof import('../src/ipc/scorecards') = require('../src/ipc/scorecards');
    ok('scorecard: attainment / change display strings are the server\'s, from its own figures',
      row.attainmentDisplay === scMod.attainmentText(row.attainment) && row.pctDisplay === scMod.pctText(row.pct) && /%$/.test(row.attainmentDisplay), JSON.stringify(row));
    ok('scorecard: tallies and group share counted by the server', same(cmp.body.counts, { good: row.status === 'good' ? 1 : 0, warn: row.status === 'warn' ? 1 : 0, off: row.status === 'off' ? 1 : 0, none: 0 })
      && cmp.body.groups[0].share === (row.status === 'good' ? 100 : 0), JSON.stringify([cmp.body.counts, cmp.body.groups]));
    ok('scorecard: pctText rounds like the page (1 decimal under 10%, a real minus)', scMod.pctText(4.25) === '+4.3%' && scMod.pctText(-12.6) === '−13%' && scMod.pctText(null) === '');
    const det = await call('scorecard:detail', { projectId: pid, id: sc.body.scorecard.id, metricId: s.rev });
    ok('scorecard:detail: attainmentDisplay with the figures', det.body.ok && det.body.attainmentDisplay === scMod.attainmentText(det.body.attainment));
    const scr = await call('scorecard:createReport', { projectId: pid, id: sc.body.scorecard.id });
    const scPages = await call('report:preview', { projectId: pid, id: scr.body.report.id });
    const scPage = scPages.body.pages.find((p: { kind: string }) => p.kind === 'scorecard');
    ok('scorecard report: a native table of the server\'s display strings', scPage && scPage.grid.body[0][2] === row.display && scPage.grid.body[0][4] === row.attainmentDisplay, JSON.stringify(scPage));

    // ── no path reaches a browser; the path channels are not on the API ───
    await context.runInContext(dev, 'w', () => reportSpec.updateReport(pid, rid, { lastFile: '/Users/someone/Desktop/board.pdf', schedule: { cadence: 'daily', at: '09:00', folder: '/Users/someone/Reports' } }));
    const after = JSON.stringify([(await call('reports:list', { projectId: pid })).body, (await call('reports:get', { projectId: pid, id: rid })).body, (await call('reports:open', { projectId: pid, id: rid })).body]);
    ok('paths: a desktop-imported lastFile / schedule folder never reaches a reply', !after.includes('/Users/someone'), after.slice(0, 300));
    let paths404 = true;
    for (const ch of ['reports:pickFolder', 'reports:saveAs', 'reports:reveal', 'reports:writeScheduled', 'reports:due', 'scorecard:snapshot', 'reports:caption']) {
      if ((await call(ch, { projectId: pid, id: rid })).status !== 404) paths404 = false;
    }
    ok('paths: folder picker, save, reveal, scheduled write, due list (and the internal snapshot/caption) are 404', paths404);
    ok('edge: a browser cannot set lastRunAt / lastFile / a schedule folder (strict patch → 400)',
      (await call('reports:update', { projectId: pid, id: rid, patch: { lastFile: '/etc/passwd' } })).status === 400
      && (await call('reports:update', { projectId: pid, id: rid, patch: { schedule: { cadence: 'daily', at: '09:00', folder: '/tmp' } } })).status === 400);
    const gen = await call('reports:generated', { projectId: pid, id: rid });
    ok('reports:generated stamps lastRunAt with the server clock', gen.body.ok && Math.abs(Date.parse(gen.body.lastRunAt) - Date.now()) < 60_000);
    const dup = await call('reports:duplicate', { projectId: pid, id: rid });
    const del = await call('reports:delete', { projectId: pid, id: dup.body.report.id });
    ok('duplicate → delete to the Trash', dup.body.ok && del.body.ok && JSON.stringify((await call('trash:list', { projectId: pid })).body).includes(dup.body.report.id));
  } finally {
    await app.close();
  }
}

async function partTwo(adminUrl: string): Promise<void> {
  const dbName = `ordinate_t213_${process.pid}_${Date.now()}`;
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
    for (const [who, role] of [['alice', 'viewer'], ['bob', 'editor']]) await boss.call('project:share', { projectId: pid, member: { userId: await uid(who) }, role });
    const bossId: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const s = await seed(bossId, pid);
    const rid: string = (await boss.call('reports:create', { projectId: pid, analysisId: s.aid })).body.report.id;
    const sid: string = (await boss.call('story:create', { projectId: pid, name: 'S' })).body.id;
    const scid: string = (await boss.call('scorecard:create', { projectId: pid, name: 'C', rows: [{ metricId: s.rev }] })).body.scorecard.id;

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
    type Cell = [string, () => unknown, 'read' | 'write'];
    const cells: Cell[] = [
      ['reports:list', () => ({ projectId: pid }), 'read'],
      ['reports:get', () => ({ projectId: pid, id: rid }), 'read'],
      ['reports:open', () => ({ projectId: pid, id: rid }), 'read'],
      ['report:preview', () => ({ projectId: pid, id: rid, page: 0 }), 'read'],
      ['report:build', () => ({ projectId: pid, id: rid }), 'read'],
      ['story:list', () => ({ projectId: pid }), 'read'],
      ['story:get', () => ({ projectId: pid, id: sid }), 'read'],
      ['story:figures', () => ({ projectId: pid, blocks: [{ id: 'm', kind: 'metric', metricId: s.rev }] }), 'read'],
      ['story:export', () => ({ projectId: pid, id: sid }), 'read'],
      ['scorecard:list', () => ({ projectId: pid }), 'read'],
      ['scorecard:get', () => ({ projectId: pid, id: scid }), 'read'],
      ['scorecard:compute', () => ({ projectId: pid, id: scid }), 'read'],
      ['scorecard:detail', () => ({ projectId: pid, id: scid, metricId: s.rev }), 'read'],
      ['reports:create', () => ({ projectId: pid, analysisId: s.aid }), 'write'],
      ['reports:update', () => ({ projectId: pid, id: rid, patch: { name: 'R' } }), 'write'],
      ['reports:duplicate', () => ({ projectId: pid, id: rid }), 'write'],
      ['reports:generated', () => ({ projectId: pid, id: rid }), 'write'],
      ['story:create', () => ({ projectId: pid, name: 'New' }), 'write'],
      ['story:update', () => ({ projectId: pid, id: sid, name: 'S' }), 'write'],
      ['scorecard:create', () => ({ projectId: pid, name: 'New' }), 'write'],
      ['scorecard:update', () => ({ projectId: pid, id: scid, patch: { name: 'C' } }), 'write'],
      ['scorecard:duplicate', () => ({ projectId: pid, id: scid }), 'write'],
      ['scorecard:createReport', () => ({ projectId: pid, id: scid }), 'write'],
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
      lines.push(`     ${ch.padEnd(24)} ${access.padEnd(6)} ${line.join(' ')}`);
    }
    console.log('     channel                  access viewer editor org-admin\n' + lines.join('\n'));
    ok('roles: every T2.13 channel allows exactly the roles its access names', wrong === 0, wrong);
    ok('roles: a denied call never reached its handler (spy)', leaks === 0, leaks);
    const audit = await pool.query<{ channel: string }>(`SELECT DISTINCT channel FROM audit_log WHERE outcome = 'ok' AND channel IN ('report:build', 'story:export', 'report:preview')`);
    const chans = audit.rows.map((r) => r.channel).sort().join();
    ok('audit: the two exports are on the trail; the preview is not', chans === 'report:build,story:export', chans);
    for (const ch of ['story:delete', 'scorecard:delete', 'reports:delete']) {
      const id = ch === 'story:delete' ? sid : ch === 'scorecard:delete' ? scid : rid;
      const v = await as('alice').call(ch, { projectId: pid, id });
      const e = await as('bob').call(ch, { projectId: pid, id });
      ok(`roles: ${ch} is an editor's (viewer 403, editor 200)`, v.status === 403 && e.status === 200, `${v.status} ${e.status}`);
    }
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
    else console.log('skip reports DB part: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
