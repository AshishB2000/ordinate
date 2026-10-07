// Dashboards, sharing, alerts, comments over the server's RPC (T2.9) — real
// HTTP, server mode.
//
//   Part 1 (always, no DB): two orgs through an identify override.
//     publish to a URL  publish:run → /p/<id>/ for a member: the page the
//                       desktop would write (sanitizePage → pageHtml), its OWN
//                       CSP as the header (+ frame-ancestors), a canary planted
//                       in a visual absent; a member of ANOTHER org gets the
//                       same 404 as a made-up id; signed out → sign-in; a
//                       public link is refused while the org has no setting;
//                       a site of another project is "not found"; re-publish
//                       keeps the link; unpublish closes it
//     export            dashboard:exportHtml → a download token → the page
//     comments          the author is the SIGNED-IN user, never a sent name
//                       (an `author` field is a 400); another member cannot
//                       edit or delete it
//     As of             analysis:tiles under asOf carries no delta
//   Part 2 (DATABASE_URL): header sign-in on a scratch database.
//     public links      off by default (a signed-out visitor is sent to sign
//                       in); an admin turns them on → the `link` site opens
//                       for anyone, an `org` site still does not; off again →
//                       closed at once
//     roles             every T2.9 channel by project role; a denied call
//                       never reaches its handler
//
//   npm run build:ts && node scripts/test-dashboardsServer.js

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
const api: typeof import('../src/api/index') = require('../src/api/index');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const { pageCsp } = require('../src/server/published') as typeof import('../src/server/published');
const hosted: typeof import('../src/publish/hosted') = require('../src/publish/hosted');

/** The page's data block (sanitizePage's output), parsed. */
function dataBlock(html: string): any { // any: the page's JSON, read field by field
  const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dashboards-'));
type Identity = import('../src/server/context').Identity;
// any: each channel's own reply shape
type Reply = { status: number; body: any };
const CANARY = 'CANARY-sk-live-9f3e1d';

async function seed(who: Identity, projectId: string) {
  return context.runInContext(who, 'seed', async () => {
    const rows: Array<[string, string, number]> = [];
    for (let m = 1; m <= 6; m++) for (const r of ['North', 'South']) rows.push([r, `2025-0${m}-15`, m * 10]);
    const d = await datasets.saveDataset(projectId, {
      name: 'Orders', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }],
      rows,
    });
    if (!d) throw new Error('seed dataset');
    const v = await visuals.saveVisual(projectId, {
      name: 'Sales by region', datasetId: d.id, chartType: 'bar',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
      overrides: { title: 'Sales', secretToken: CANARY },
    } as never);
    if (!v) throw new Error('seed visual');
    const card = (type: string, x: number, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x, y: 0, w: 4, h: 4 }, ...extra });
    const a = await analysis.saveAnalysis(projectId, {
      name: 'Board',
      sheets: [{
        name: 'Overview',
        cards: [
          card('text', 0, { heading: 'Hello </script><script>alert(1)</script>', text: 'Body' }),
          card('visual', 4, { visualId: v.id }),
          card('metric', 8, { metric: { datasetId: d.id, column: 'amount', aggregation: 'sum', compare: { mode: 'previous_period' } } }),
        ],
      }],
    });
    if (!a) throw new Error('seed analysis');
    return { ds: d.id, v: v.id, aid: a.id };
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
  const page = (p: string) => fetch(`${base}${p}`, { headers: { accept: 'text/html', ...headers }, redirect: 'manual' });
  return { call, page };
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
}

const ALICE: Identity = { user: { email: 'alice@acme.test', role: 'admin' }, org: { id: 'default' } };
const BOB: Identity = { user: { email: 'bob@acme.test', role: 'admin' }, org: { id: 'default' } };
const EVE: Identity = { user: { email: 'eve@other.test', role: 'admin' }, org: { id: 'other' } };
const WHO: Record<string, Identity> = { alice: ALICE, bob: BOB, eve: EVE };

async function partOne(): Promise<void> {
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }), undefined, (h) => WHO[String(h['x-who'] ?? '')] ?? null);
  const base = await listen(app);
  const alice = client(base, { 'x-who': 'alice' });
  const bob = client(base, { 'x-who': 'bob' });
  const eve = client(base, { 'x-who': 'eve' });
  const anon = client(base);
  try {
    const pid: string = (await alice.call('projects:create', { name: 'Dashboards' })).body.id;
    const other: string = (await alice.call('projects:create', { name: 'Other' })).body.id;
    const s = await seed(ALICE, pid);

    // ── Publish to a URL ─────────────────────────────────────────────────
    const t = await alice.call('publish:targets', { projectId: pid });
    ok('targets: the project\'s dashboards', t.status === 200 && t.body.dashboards.length === 1 && t.body.dashboards[0].id === s.aid);
    const plan = await alice.call('publish:plan', { projectId: pid, dashboardIds: [s.aid] });
    ok('plan: sized against the 50 MB limit, writes nothing', plan.body.ok && plan.body.plan.pages.length === 1 && !plan.body.plan.tooBig, JSON.stringify(plan.body).slice(0, 200));
    const link = await alice.call('publish:run', { projectId: pid, dashboardIds: [s.aid], access: 'link' });
    ok('run: a public link is refused while the org has not turned public links on', link.body.ok === false && /public links/.test(link.body.error), JSON.stringify(link.body));
    const run = await alice.call('publish:run', { projectId: pid, dashboardIds: [s.aid], options: { title: 'Board site' } });
    ok('run: published, org access by default, by the signed-in user', run.body.ok && run.body.site.access === 'org' && run.body.site.publishedBy === ALICE.user.email, JSON.stringify(run.body).slice(0, 300));
    const site = run.body.site;
    const file = site.pages[0].file;
    const r = await alice.page(`/p/${site.id}/${file}`);
    const html = await r.text();
    ok('serve: a member gets the page', r.status === 200 && /<title>Board · Board site<\/title>/.test(html), `${r.status} ${html.slice(0, 120)}`);
    const csp = r.headers.get('content-security-policy') ?? '';
    ok('serve: the header CSP IS the page\'s own pinned policy + frame-ancestors \'none\'', csp === `${pageCsp(html)}; frame-ancestors 'none'` && /script-src 'sha256-/.test(csp) && !csp.includes("'self'"), csp.slice(0, 160));
    ok('serve: no-store, noindex', r.headers.get('cache-control') === 'no-store' && r.headers.get('x-robots-tag') === 'noindex');
    ok('whitelist: a key the sanitizer does not name (a planted canary) never reaches the page', !html.includes(CANARY));
    ok('whitelist: markup in a heading cannot close the data block', !html.includes('</script><script>alert(1)'));
    const idx = await alice.page(`/p/${site.id}/`);
    ok('serve: the index page; the bare link adds the slash', idx.status === 200 && (await idx.text()).includes(file) && (await alice.page(`/p/${site.id}`)).headers.get('location') === `/p/${site.id}/`);
    const nope = await eve.page(`/p/${site.id}/${file}`);
    const made = await eve.page(`/p/${crypto.randomUUID()}/${file}`);
    ok('access: a signed-in member of ANOTHER org gets nothing — the same 404 as a made-up id', nope.status === 404 && made.status === 404 && (await nope.text()) === (await made.text()));
    const out = await anon.page(`/p/${site.id}/${file}`);
    ok('access: signed out → sign in (nothing of the page)', out.status === 302 && out.headers.get('location') === `/sign-in?next=${encodeURIComponent(`/p/${site.id}/${file}`)}`);
    ok('serve: a traversal-shaped page name is a 404', (await alice.page(`/p/${site.id}/..%2Fmanifest.json`)).status === 404 && (await alice.page(`/p/${site.id}/manifest.json`)).status === 404);
    const sites = await alice.call('publish:sites', { projectId: pid });
    ok('sites: listed for the project, public links off (no DB)', sites.body.sites.length === 1 && sites.body.publicLinks === false);
    ok('sites: another project lists none', (await alice.call('publish:sites', { projectId: other })).body.sites.length === 0);
    ok('scope: a site cannot be changed through another project', (await alice.call('publish:unpublish', { projectId: other, id: site.id })).body.ok === false
      && (await alice.call('publish:run', { projectId: other, dashboardIds: [s.aid], id: site.id })).body.ok === false);
    await alice.call('analysis:update', { projectId: pid, id: s.aid, name: 'Board v2' });
    const again = await alice.call('publish:run', { projectId: pid, dashboardIds: [s.aid], id: site.id });
    const newFile = again.body.site?.pages[0].file;
    ok('re-publish: same link, the edit carried, the old page gone', again.body.site?.id === site.id && newFile !== file
      && (await alice.page(`/p/${site.id}/${newFile}`)).status === 200 && (await alice.page(`/p/${site.id}/${file}`)).status === 404);
    ok('unpublish: the link closes', (await alice.call('publish:unpublish', { projectId: pid, id: site.id })).body.ok === true
      && (await alice.page(`/p/${site.id}/`)).status === 404);

    // ── Export ───────────────────────────────────────────────────────────
    const ex = await alice.call('dashboard:exportHtml', { projectId: pid, id: s.aid });
    const dl = await fetch(`${base}/api/files/${ex.body.downloadToken}`, { headers: { 'x-who': 'alice' } });
    const exHtml = await dl.text();
    ok('export: a download of the one-page build, pinned CSP, no canary', ex.body.ok && dl.status === 200 && /attachment; filename="Board-v2.html"/.test(dl.headers.get('content-disposition') ?? '')
      && !!pageCsp(exHtml) && !exHtml.includes(CANARY), `${dl.status} ${dl.headers.get('content-disposition')}`);

    // ── Comments ─────────────────────────────────────────────────────────
    const target = { kind: 'analysis', id: s.aid };
    const sent = await alice.call('comment:add', { projectId: pid, target, body: 'Check the North figure', author: 'The CEO' });
    ok('comments: a sent author is refused at the edge (400)', sent.status === 400);
    const add = await alice.call('comment:add', { projectId: pid, target, body: 'Check the North figure' });
    const c = add.body.comments?.[0];
    ok('comments: the author is the signed-in user', add.body.ok && c.author === ALICE.user.email && c.mine === true, JSON.stringify(c));
    const asBob = await bob.call('comment:list', { projectId: pid });
    ok('comments: another member sees it, not as theirs', asBob.body.comments[0].author === ALICE.user.email && asBob.body.comments[0].mine === false);
    const rep = await bob.call('comment:reply', { projectId: pid, id: c.id, body: 'On it' });
    ok('comments: a reply carries ITS author', rep.body.comments[0].replies[0].author === BOB.user.email);
    ok('comments: another member cannot edit or delete it', (await bob.call('comment:edit', { projectId: pid, id: c.id, body: 'x' })).body.ok === false
      && (await bob.call('comment:delete', { projectId: pid, id: c.id })).body.ok === false);
    ok('comments: the author can', (await alice.call('comment:edit', { projectId: pid, id: c.id, body: 'Edited' })).body.comments[0].body === 'Edited');
    ok('comments: another org reads none of them', (await eve.call('comment:list', { projectId: pid })).status === 403);

    // ── As of: no delta ──────────────────────────────────────────────────
    const tile = { kind: 'metric', datasetId: s.ds, column: 'amount', aggregation: 'sum', compare: { mode: 'previous_period' },
      filters: [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2025-06-01', to: '2025-06-30' } }] };
    const live = (await alice.call('analysis:tiles', { projectId: pid, items: [tile] })).body[0];
    const past = (await alice.call('analysis:tiles', { projectId: pid, asOf: new Date().toISOString(), items: [tile] })).body[0];
    ok('as-of: the live KPI carries its delta; under As of there is none', live.compare && typeof live.compare.delta === 'number' && past.compare === undefined, JSON.stringify([live.compare, past]).slice(0, 200));

    // ── Pivot export = the on-screen grid, under a non-default parameter ─
    const pivotEnc = {
      category: 'region', series: 'day', values: [{ column: 'amount', aggregation: 'sum' }],
      pivot: { rows: [{ column: 'region' }], columns: [], values: [{ column: 'amount', aggregation: 'sum' }], totals: { rows: true, columns: true, grand: true } },
    };
    const byParam = [{ type: 'filter', column: 'amount', op: '>', value: '[[min]]' }];
    const params = [{ name: 'min', kind: 'number', value: 35 }];
    const onScreen = (await alice.call('analysis:tiles', { projectId: pid, params, items: [{ kind: 'visual', datasetId: s.ds, encoding: pivotEnc, filters: byParam }] })).body[0];
    const exported = await alice.call('visual:data', { projectId: pid, datasetId: s.ds, encoding: pivotEnc, filters: byParam, params, share: 'export' });
    const bare = await alice.call('visual:data', { projectId: pid, datasetId: s.ds, encoding: pivotEnc, filters: byParam, share: 'export' });
    ok('pivot export: visual:data takes the sheet\'s parameters (the array paramValues reads)', exported.status === 200 && exported.body.ok, `${exported.status} ${JSON.stringify(exported.body).slice(0, 160)}`);
    ok('pivot export: under a non-default parameter the exported grid IS the on-screen grid (Object.is at every cell)',
      !!onScreen.data?.pivot && JSON.stringify(exported.body.data?.pivot) === JSON.stringify(onScreen.data.pivot)
      && Object.is(exported.body.data.pivot.grand?.[0], onScreen.data.pivot.grand?.[0]), JSON.stringify([exported.body.data?.pivot?.grand, onScreen.data?.pivot?.grand]));
    ok('pivot export: …and differs from the grid without it (negative control)', JSON.stringify(bare.body.data?.pivot) !== JSON.stringify(onScreen.data?.pivot));
    ok('pivot export: a record of params (the old shape) is a 400', (await alice.call('visual:data', { projectId: pid, datasetId: s.ds, encoding: pivotEnc, params: { min: 35 } })).status === 400);

    // ── Re-publish after a refresh ───────────────────────────────────────
    // A SQL dataset over another one (a re-fetchable origin with no network), a
    // site published with "Re-publish after data refreshes", the base table
    // changed, then dataset:refresh: the server rebuilds the site at the SAME
    // link with the new figures.
    hosted.setRepublishDelayForTest(0);
    const feedSet = await context.runInContext(ALICE, 'seed', async () => {
      const cols = [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }];
      const base = await datasets.saveDataset(pid, { name: 'Feed base', sourceKind: 'csv', columns: cols, rows: [['North', 111], ['South', 222]] } as never);
      const feed = await datasets.saveDataset(pid, {
        name: 'Feed', sourceKind: 'sql', columns: cols, rows: [['North', 111], ['South', 222]],
        origin: { kind: 'sql', sql: 'SELECT region, amount FROM "Feed base"', deps: [base!.id] },
      } as never);
      const v = await visuals.saveVisual(pid, { name: 'Feed by region', datasetId: feed!.id, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as never);
      const a = await analysis.saveAnalysis(pid, { name: 'Feed board', sheets: [{ name: 'One', cards: [{ id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 0, w: 6, h: 6 }, visualId: v!.id }] }] });
      return { base: base!.id, ds: feed!.id, aid: a!.id };
    });
    const auto = (await alice.call('publish:run', { projectId: pid, dashboardIds: [feedSet.aid], options: { afterRefresh: true } })).body.site;
    const manual = (await alice.call('publish:run', { projectId: pid, dashboardIds: [feedSet.aid] })).body.site;
    const figure = async (id: string) => {
      const site = await context.runInContext(ALICE, 'r', () => hosted.getSite(id));
      const html = await (await alice.page(`/p/${id}/${site!.pages[0].file}`)).text();
      const card = dataBlock(html).dashboard.sheets[0].cards.find((c: { kind: string }) => c.kind === 'chart');
      return { at: site!.publishedAt, values: card.payloads[card.variants[0]].series[0].values as number[] };
    };
    const before = await figure(auto.id);
    ok('republish: the published page shows the data as it was', JSON.stringify(before.values) === '[111,222]', JSON.stringify(before.values));
    await context.runInContext(ALICE, 'edit', async () => {
      const b = await datasets.getDataset(pid, feedSet.base);
      await datasets.persist(pid, { ...b!, rows: [['North', 999], ['South', 1]] } as never);
    });
    const rf = await alice.call('dataset:refresh', { projectId: pid, id: feedSet.ds });
    await hosted.republishSettled();
    const after = await figure(auto.id);
    ok('republish: dataset:refresh succeeded', rf.body?.ok === true, JSON.stringify(rf.body).slice(0, 200));
    ok('republish: the opted-in site is rebuilt with the new figures — at the SAME link', JSON.stringify(after.values) === '[999,1]' && after.at !== before.at
      && (await alice.page(`/p/${auto.id}/`)).status === 200, JSON.stringify([after.values, before.at, after.at]));
    ok('republish: a site that did not opt in keeps its snapshot', JSON.stringify((await figure(manual.id)).values) === '[111,222]');
    ok('republish: a refresh of a dataset the site does not read rebuilds nothing', (await context.runInContext(ALICE, 'r', () => hosted.republishUsing(pid, new Set([s.ds])))).length === 0);

    // ── A custom accent travels: the brand ramp in the publish config paints the page ─
    const ramp = { accent: '#7c3aed', accent2: '#6d28d9', soft: 'rgba(124, 58, 237, 0.08)', line: 'rgba(124, 58, 237, 0.22)', chart: ['#7c3aed', '#0e7490', '#14b8a6', '#6366f1', '#64748b', '#b45309', '#be185d', '#4d7c0f'] };
    const branded = (await alice.call('publish:run', { projectId: pid, dashboardIds: [feedSet.aid], brands: { [feedSet.aid]: { ramp } } })).body.site;
    const brandedHtml = await (await alice.page(`/p/${branded.id}/${branded.pages[0].file}`)).text();
    ok('brand: the ramp the browser computed reaches the page (sanitizeBrand kept it)', brandedHtml.includes('#7c3aed') && !(await (await alice.page(`/p/${manual.id}/${manual.pages[0].file}`)).text()).includes('#7c3aed'));
    ok('brand: it is kept for a re-publish', JSON.stringify(branded.config.brands?.[feedSet.aid]?.ramp?.accent) === '"#7c3aed"');

    // ── Alerts ───────────────────────────────────────────────────────────
    const rule = { datasetId: s.ds, name: 'Low sales', metric: { column: 'amount', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '<', value: 1e9 }, enabled: true, id: crypto.randomUUID() };
    const test = await alice.call('alerts:test', { projectId: pid, rule });
    ok('alerts: test says whether a rule would fire', test.body.ok && test.body.fire === true, JSON.stringify(test.body));
    const saved = await alice.call('alerts:save', { projectId: pid, rule });
    const list = await alice.call('alerts:list', { projectId: pid });
    ok('alerts: saved and listed', saved.body.ok && list.body.rules.some((x: { id: string }) => x.id === saved.body.rule.id), JSON.stringify(saved.body).slice(0, 200));
  } finally {
    await app.close().catch(() => undefined);
  }
}

async function partTwo(adminUrl: string): Promise<void> {
  const dbName = `ordinate_t29_${process.pid}_${Date.now()}`;
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
    const as = (who: string) => client(base, { 'x-forwarded-email': `${who}@acme.test` });
    for (const p of ['boss', 'alice', 'bob']) await as(p).call('projects:list');
    const uid = async (who: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${who}@acme.test`])).rows[0].id;
    const boss = as('boss');
    const anon = client(base);
    const pid: string = (await boss.call('projects:create', { name: 'Shared' })).body.id;
    for (const [who, role] of [['alice', 'viewer'], ['bob', 'editor']]) {
      await boss.call('project:share', { projectId: pid, member: { userId: await uid(who) }, role });
    }
    const s = await seed({ user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } }, pid);

    // ── Public links ─────────────────────────────────────────────────────
    const orgSite = (await boss.call('publish:run', { projectId: pid, dashboardIds: [s.aid] })).body.site;
    ok('links: off by default — a public site is refused', (await boss.call('publish:run', { projectId: pid, dashboardIds: [s.aid], access: 'link' })).body.ok === false);
    const settings = (await boss.call('admin:settings')).body;
    await boss.call('admin:saveSettings', { publicLinks: true, aiProviders: settings.aiProviders, uploadCapMb: settings.uploadCapMb });
    const pub = (await boss.call('publish:run', { projectId: pid, dashboardIds: [s.aid], access: 'link' })).body.site;
    ok('links: on — a public site is published', pub && pub.access === 'link');
    const open = await anon.page(`/p/${pub.id}/`);
    ok('links: anyone with the link opens it, signed out', open.status === 200 && !!open.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    ok('links: an org-only site still sends the signed-out to sign in', (await anon.page(`/p/${orgSite.id}/`)).status === 302);
    ok('links: an org member opens the org-only site', (await as('alice').page(`/p/${orgSite.id}/`)).status === 200);
    await boss.call('admin:saveSettings', { publicLinks: false, aiProviders: settings.aiProviders, uploadCapMb: settings.uploadCapMb });
    ok('links: off again — the public site closes at once, without touching it', (await anon.page(`/p/${pub.id}/`)).status === 302);
    ok('links: …and the site cannot be made public again', (await boss.call('publish:access', { projectId: pid, id: orgSite.id, access: 'link' })).body.ok === false);

    // ── Roles ────────────────────────────────────────────────────────────
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
    const rule = { datasetId: s.ds, name: 'R', metric: { column: 'amount', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '<', value: 1 }, enabled: true, id: crypto.randomUUID() };
    const ruleId = (await boss.call('alerts:save', { projectId: pid, rule })).body.rule.id;
    const cid = (await boss.call('comment:add', { projectId: pid, target: { kind: 'analysis', id: s.aid }, body: 'x' })).body.comments[0].id;
    type Cell = [string, () => unknown, 'read' | 'write'];
    const cells: Cell[] = [
      ['publish:targets', () => ({ projectId: pid }), 'read'],
      ['publish:plan', () => ({ projectId: pid, dashboardIds: [s.aid] }), 'read'],
      ['publish:sites', () => ({ projectId: pid }), 'read'],
      ['dashboard:exportHtml', () => ({ projectId: pid, id: s.aid }), 'read'],
      ['dashboard:asOfStamps', () => ({ projectId: pid, datasetIds: [s.ds], metricIds: [] }), 'read'],
      ['summary:compute', () => ({ projectId: pid, pages: [] }), 'read'],
      ['fx:get', () => ({ projectId: pid }), 'read'],
      ['comment:list', () => ({ projectId: pid }), 'read'],
      ['comment:add', () => ({ projectId: pid, target: { kind: 'analysis', id: s.aid }, body: 'hi' }), 'read'],
      ['comment:resolve', () => ({ projectId: pid, id: cid }), 'read'],
      ['alerts:list', () => ({ projectId: pid }), 'read'],
      ['alerts:test', () => ({ projectId: pid, rule }), 'read'],
      ['drivers:explainAlert', () => ({ projectId: pid, ruleId }), 'read'],
      ['publish:run', () => ({ projectId: pid, dashboardIds: [s.aid], id: orgSite.id }), 'write'],
      ['publish:access', () => ({ projectId: pid, id: orgSite.id, access: 'org' }), 'write'],
      ['fx:dashboard', () => ({ projectId: pid, dashboardId: s.aid, code: null }), 'write'],
      ['alerts:save', () => ({ projectId: pid, rule }), 'write'],
      ['alerts:patch', () => ({ projectId: pid, ruleId, patch: { enabled: true } }), 'write'],
      ['alerts:markSeen', () => ({ projectId: pid }), 'write'],
      ['alerts:setDigest', () => ({ projectId: pid, on: false }), 'write'],
      ['publish:unpublish', () => ({ projectId: pid, id: crypto.randomUUID() }), 'write'],
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
    ok('roles: every T2.9 channel allows exactly the roles its access names', wrong === 0, wrong);
    ok('roles: a denied call never reached its handler (spy)', leaks === 0, leaks);
    const audit = await pool.query<{ channel: string }>(`SELECT channel FROM audit_log WHERE outcome = 'ok' AND channel IN ('publish:run', 'comment:add', 'dashboard:exportHtml')`);
    ok('audit: publishing, commenting and exporting are on the trail', new Set(audit.rows.map((x) => x.channel)).size === 3, JSON.stringify(audit.rows));
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
    else console.log('skip dashboards DB part: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
