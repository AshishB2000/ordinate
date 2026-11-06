// The bench for scripts/test-sharePolicyPart5.ts — a helper, not a suite. Every way a part 5 figure leaves the org,
// read as an outside reader gets it (the release B fix's surfaces, src/publish/kpiPolicy.ts):
//
//   /p/ pages     a dashboard's KPI tiles, a story's metric blocks, a scorecard's rows (publish:run, GET /p/<id>/<file>)
//   an embed      the KPI tiles (embedHtml)          the HTML export  the KPI tiles (dashboardPageHtml)
//   a report      its sheet's KPIs (report:build)    a story export   its metric blocks (story:export)
//   a send        a subscription's KPIs (subscription:preview, the Slack model)
//   alert posts   what a local Slack receiver gets   MCP           metric_value (automation/handlers)
//
// Server mode, dev sign-in. Each world is its own project, so one part's fixture never moves another's pins.

import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const scorecards: typeof import('../src/analysis/scorecards') = require('../src/analysis/scorecards');
const reportSpec: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const alertPosts: typeof import('../src/server/subscriptions/alertPosts') = require('../src/server/subscriptions/alertPosts');
const handlers: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const pub: typeof import('../src/publish/publish') = require('../src/publish/publish');
const embedPage: typeof import('../src/publish/embedPage') = require('../src/publish/embedPage');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const format: typeof import('../src/app/format') = require('../src/app/format');
const { todayIso }: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
export const HIDDEN: string = require('../src/app/sharePolicy').HIDDEN_BY_POLICY;

const DEV: B.Identity = { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
const JOBS: B.Identity = { user: { email: 'jobs@system', role: 'admin' }, org: { id: 'default' } };
export const show = (v: unknown): string => String(JSON.stringify(v)).slice(0, 400);
/** A fixed id, so the pins hold run to run. */
export const U = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** The day the bench started: a send is dated the day it is composed, so a render before midnight and its twin after it pin the same. */
const DAY0 = todayIso();
/** What differs run to run — ids, times, the day (the bench's first and today's) — taken out, then hashed. */
export const pin = (v: unknown): string => crypto.createHash('sha256').update([DAY0, todayIso()].reduce((s, day) => s.split(day).join('D').split(format.formatDate(day)).join('D'), JSON.stringify(v)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'T')
  .replace(/[A-Z][a-z]{2} \d{1,2}, \d{4},? \d{1,2}:\d{2} [AP]M UTC/g, 'A')), 'utf8').digest('hex');

function dataBlock(html: string): any { // any: the page's JSON, read field by field
  const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

export interface Env {
  base: string;
  rpc: (channel: string, payload: unknown) => Promise<any>; // any: each channel's reply
  inApp: <T>(fn: () => Promise<T>) => Promise<T>;
  channelIds: string[];
  rx: Awaited<ReturnType<typeof B.receiver>>;
  close: () => Promise<void>;
}

export async function start(): Promise<Env> {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-part5-'));
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  B.openLoopback();
  format.setFormatPrefs({ locale: 'en-US' }); // the displays the pins read, whatever the machine's locale
  const rx = await B.receiver();
  B.channels.useChannelSecrets(B.memoryStore());
  delete process.env.ORDINATE_PUBLIC_URL;
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }));
  const base = await B.listen(app);
  const { call } = B.client(base);
  const rpc = async (channel: string, payload: unknown): Promise<any> => (await call(channel, payload)).body; // any: as above
  const channelIds = [(await rpc('channel:save', { name: 'Ops', kind: 'slack', webhookUrl: rx.url() })).channel.id];
  return { base, rpc, inApp: (fn) => B.context.runInContext(DEV, 'test', fn), channelIds, rx, close: async () => { await app.close(); await rx.close(); } };
}

/** One part's fixture: what it publishes, and the names each surface calls its marked and open figures by. */
export interface Fx {
  P: string;
  board: string; story: string; sc: string; report: string;
  rules: Array<{ id: string; name: string }>;
  /** Each rule's firing, from one tick right after the save (unmarked): what every later post re-sends. */
  events: import('../src/analysis/alerts').AlertEvent[];
  mcp: string[];
}

/** A KPI tile (`metric`), or a chart (`visual`: a saved visual of that name on `datasetId`). */
export interface Card { title: string; metric?: Record<string, unknown>; visual?: { datasetId: string; encoding: Record<string, unknown>; chartType?: string } }
/** A dashboard of tiles, a story and a scorecard of `metricIds`, a report on the dashboard, and alert `rules`. */
export async function publishable(env: Env, P: string, cards: Card[], metricIds: string[], rules: Array<Record<string, unknown>>, mcp: string[]): Promise<Fx> {
  const out = await env.inApp(async () => {
    const tiles = [];
    for (const [i, c] of cards.entries()) {
      const layout = { x: (i % 4) * 3, y: Math.floor(i / 4) * 3, w: 3, h: 3 };
      if (!c.visual) { tiles.push({ id: U(i + 1), type: 'metric', layout, metric: { ...c.metric, label: c.title } }); continue; }
      const v = (await visuals.saveVisual(P, { datasetId: c.visual.datasetId, name: c.title, chartType: c.visual.chartType ?? 'column', encoding: c.visual.encoding } as never))!;
      tiles.push({ id: U(i + 1), type: 'visual', layout, visualId: v.id });
    }
    const board = (await analysis.saveAnalysis(P, { name: 'Board', sheets: [{ id: U(90), name: 'Main', cards: tiles }] } as never))!;
    const story = (await stories.saveStory(P, { name: 'Story', blocks: metricIds.map((id, i) => ({ id: U(10 + i), kind: 'metric', metricId: id, filters: [] })) } as never))!;
    const sc = (await scorecards.saveScorecard(P, { name: 'Card', period: 'month', rows: metricIds.map((metricId) => ({ metricId })) } as never))!;
    const report = (await reportSpec.saveReport(P, { name: 'Report', analysisId: board.id, pages: [{ kind: 'sheet', sheetIdx: 0, include: true, layout: 'full' }] } as never))!;
    return { board: board.id, story: story.id, sc: sc.id, report: report.id };
  });
  const saved = [];
  for (const [i, r] of rules.entries()) saved.push((await env.rpc('alerts:save', { projectId: P, rule: { id: U(50 + i), channelIds: env.channelIds, ...r } })).rule);
  const events = saved.length ? await B.context.runInContext(JOBS, 'job:tick:default', () => alertStore.evaluateProject(P)) : [];
  return { P, ...out, rules: saved.map((r: any) => ({ id: r.id, name: r.name })), events, mcp }; // any: alerts:save's rule
}

/** A project with the Staff table: Ops and Lab, January to June 2025, a salary and hours each month. */
export async function project(env: Env, name: string): Promise<{ P: string; S: string }> {
  const P: string = (await env.rpc('projects:create', { name })).id;
  const rows = [1, 2, 3, 4, 5, 6].flatMap((mo) => [['Ops', `2025-0${mo}-15`, 90037 + mo * 1000, 1203 + mo * 10], ['Lab', `2025-0${mo}-15`, 90089 + mo * 1000, 1207 + mo * 10]]);
  const S = (await env.inApp(() => datasets.saveDataset(P, { name: 'Staff', sourceKind: 'csv',
    columns: [{ name: 'team', type: 'text' }, { name: 'day', type: 'date' }, { name: 'salary', type: 'number' }, { name: 'hours', type: 'number' }], rows })))!.id;
  return { P, S };
}

export const saveMetric = (env: Env, P: string, S: string, name: string, definition: object, extra: object = {}) =>
  env.inApp(async () => (await metrics.saveMetric(P, { name, datasetId: S, definition, format: { kind: 'number', decimals: 0 }, ...extra } as never))!);

export const mark = (env: Env, P: string, S: string, column: string, on: boolean) =>
  env.inApp(() => catalog.setColumn(P, S, column, { sensitivity: on ? 'financial' : 'none' }));

/** Every surface an outside reader gets, under `action` on every share path. */
export async function leave(env: Env, fx: Fx, action: 'mask' | 'drop' | 'include') {
  const { P } = fx;
  await env.inApp(() => store.setPolicy(P, { publish: action, export: action, report: action }));
  const run = await env.rpc('publish:run', { projectId: P, dashboardIds: [fx.board], storyIds: [fx.story], scorecardIds: [fx.sc] });
  const site = run.site as import('../src/publish/hosted').HostedSite;
  const page = async (kind: string) => dataBlock(await (await fetch(`${env.base}/p/${site.id}/${site.pages.find((p) => p.kind === kind)!.file}`)).text());
  embedPage.clearEmbedCache();
  const claims = { pub: site.id, dash: fx.board, exp: 0, params: {}, hide: [] } as unknown as import('../src/server/embed/token').EmbedClaims;
  const embedded = await B.context.runAsPublished(DEV, 'embed', () => recordFs.withReadMemo(() => embedPage.embedHtml(site, fx.board, claims)));
  const sent = await env.rpc('subscription:preview', { projectId: P, draft: B.definition({ aid: fx.board } as B.Seed, []) });
  // Alert posts: the rules' firings re-sent, each under a fresh fixed id so the ledger posts it and the pin holds.
  env.rx.hits.length = 0;
  await B.context.runInContext(JOBS, 'job:tick:default', () => alertPosts.postFiredAlerts(P, fx.events.map((e, i) => ({ ...e, id: U(100 + i) }))));
  const posts = Object.fromEntries(fx.rules.map((r) => [r.name, env.rx.hits.map((h) => JSON.stringify(h.body)).filter((b) => b.includes(r.name))]));
  const mcp: Record<string, unknown> = {};
  for (const name of fx.mcp) {
    mcp[name] = await env.inApp(() => handlers.metricValue({ projectId: P, transport: 'mcp', cwd: os.tmpdir(), headless: true } as never, name))
      .catch((e: { code?: string; message?: string }) => ({ refused: e.code, message: e.message }));
  }
  return {
    dashboard: await page('dashboard'), story: await page('story'), scorecard: await page('scorecard'),
    embed: dataBlock('html' in embedded ? embedded.html : ''),
    exported: dataBlock(await env.inApp(() => pub.dashboardPageHtml(P, fx.board))),
    report: (await env.rpc('report:build', { projectId: P, id: fx.report })).pages,
    storyExport: (await env.rpc('story:export', { projectId: P, id: fx.story })).pages,
    send: sent.slack?.model,
    posts, mcp,
  };
}
export type Out = Awaited<ReturnType<typeof leave>>;

// ── reading a surface ──
const tile = (block: any, title: string): any => block?.dashboard?.sheets[0].cards.find((c: any) => c.title === title); // any: a page's JSON
const named = (rows: any[], name: string): any => rows.find((r: any) => (r.label ?? r.name) === name); // any: a KPI-ish entry
/** The figure a surface shows for `name` (a tile title, a metric name, a rule name): 'hidden', 'shown', or 'absent'. */
export function figureOn(o: Out, where: keyof Out | 'reportKpi' | 'exportKpi' | 'sendKpi' | 'storyMetric' | 'scoreRow' | 'reportTile' | 'sendChart', name: string): 'hidden' | 'shown' | 'absent' {
  const v = (x: unknown): 'hidden' | 'shown' | 'absent' => x === undefined ? 'absent' : x === HIDDEN ? 'hidden' : 'shown';
  switch (where) {
    case 'dashboard': case 'embed': case 'exported': {
      const t = tile(o[where], name);
      if (!t || !t.payloads.length) return 'absent';
      return t.payloads.every((p: any) => p.hidden === HIDDEN) ? 'hidden' : t.payloads.some((p: any) => typeof p.value === 'number' || p.labels?.length > 0) ? 'shown' : 'absent'; // any: a payload
    }
    case 'storyMetric': { const m = named((o.story?.story?.blocks || []).flatMap((b: any) => b.metrics || []), name); return m ? (m.display === HIDDEN && m.value === null ? 'hidden' : typeof m.value === 'number' ? 'shown' : 'absent') : 'absent'; } // any: as above
    case 'scoreRow': { const r = (o.scorecard?.scorecard?.rows || []).find((x: any) => x.name === name); return r ? (r.display === HIDDEN && r.spark.length === 0 ? 'hidden' : /\d/.test(r.display) ? 'shown' : 'absent') : 'absent'; } // any: a published row (its display, no raw value)
    case 'reportKpi': { const ks = (o.report || []).flatMap((p: any) => p.kpis || []).filter((k: any) => k.label === name); return ks.length ? (ks.every((k: any) => k.value === HIDDEN) ? 'hidden' : 'shown') : 'absent'; } // any: a report page
    case 'exportKpi': return v(named((o.storyExport || []).flatMap((p: any) => p.kpis || []), name)?.value); // any: as above
    case 'sendKpi': return v(named(o.send?.kpis ?? [], name)?.value);
    case 'reportTile': { const ts = (o.report || []).flatMap((p: any) => p.tiles || []).filter((x: any) => x.title === name); return ts.length ? (ts.every((x: any) => x.note === HIDDEN && !x.chart) ? 'hidden' : ts.some((x: any) => x.chart) ? 'shown' : 'absent') : 'absent'; } // any: a report tile
    case 'sendChart': { const c = (o.send?.sections ?? []).find((x: any) => x.title === name); return c ? (c.note === HIDDEN && !c.rows.length ? 'hidden' : c.rows.length ? 'shown' : 'absent') : 'absent'; } // any: a message section
    case 'posts': { const ps = o.posts[name] ?? []; return ps.length ? (ps.every((b) => b.includes(HIDDEN)) ? 'hidden' : 'shown') : 'absent'; }
    case 'mcp': { const r = o.mcp[name] as { refused?: string; message?: string; value?: unknown } | undefined; return !r ? 'absent' : r.refused === 'runtime' && /share policy/i.test(r.message ?? '') ? 'hidden' : typeof r.value === 'number' ? 'shown' : 'absent'; }
    default: return 'absent';
  }
}
