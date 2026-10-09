// Self-check for "every figure says how fresh it is" and "dashboards update
// themselves after a refresh" (docs/live-data/00-plan.md, L0.2 and L0.1) —
// real HTTP, server mode, dev sign-in, no database.
//
//   1. PURE   data/figureAsOf: the last refresh wins; a dataset never refreshed
//             is as of when its rows were saved (createdAt — a rename or a
//             prepare edit does not make data newer), an input table as of its
//             last edit; the stalest input dates a figure; the UTC label.
//   2. EVERY  door that answers a figure carries the same `asOf`: visual:data,
//             visual:dataBatch, visual:preview, dashboard:metric, metric:value,
//             metric:values, analysis:tiles (chart, KPI, statistics),
//             answer:card — and dashboard:asOfStamps' `latest` is the stalest.
//             A refusal carries none.
//   3. NEVER  CACHED: a refresh marker written after the answer was cached
//             moves the caption while the cached figure is reused (the reason
//             it is stamped outside engine/queryCache); "as of" a snapshot is
//             dated with the snapshot's time.
//   4. PUSHED a successful dataset:refresh reaches the reader's tab once as
//             hub:dataset-refreshed (the scheduler's payload); a SQL dataset
//             re-run downstream is announced too; the scheduler's tick (in
//             process, no reporter) announces through the same door; a refresh
//             that fails is not announced (negative control).
//
//   npm run build:ts && node scripts/test-figureAsOf.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');
const { randomUUID }: typeof import('crypto') = require('crypto');

const F: typeof import('../src/data/figureAsOf') = require('../src/data/figureAsOf');
const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const scheduler: typeof import('../src/app/refreshScheduler') = require('../src/app/refreshScheduler');

type Identity = import('../src/server/context').Identity;
// any: each channel's own reply shape
type Reply = { status: number; body: any };

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-asof-'));
const dev: Identity = { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SALES = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' as const }] };

// ── 1. Pure ───────────────────────────────────────────────────────────────────

const T0 = '2026-10-01T08:00:00.000Z';
const T1 = '2026-10-05T09:30:00.000Z';
const T2 = '2026-10-09T01:00:00.000Z';
ok('dataAt: the last refresh wins over every other stamp', F.dataAt({ sourceKind: 'csv', createdAt: T0, updatedAt: T2, lastRefreshedAt: T1 }) === T1);
ok('dataAt: never refreshed → when the rows were saved, NOT the last rename / prepare edit',
  F.dataAt({ sourceKind: 'csv', createdAt: T0, updatedAt: T2 }) === T0);
ok('dataAt: an input table is edited in place → its last edit', F.dataAt({ sourceKind: 'input', createdAt: T0, updatedAt: T2 }) === T2);
ok('dataAt: a stamp that does not parse is skipped, never trusted', F.dataAt({ sourceKind: 'csv', createdAt: T0, updatedAt: T2, lastRefreshedAt: 'garbage' }) === T0
  && F.dataAt({ sourceKind: 'csv', createdAt: 'x', updatedAt: 'y' }) === null);
ok('dataAt: canonical ISO out, whatever the stored spelling', F.dataAt({ sourceKind: 'csv', createdAt: '2026-10-01T10:00:00+02:00', updatedAt: T2 }) === T0);
const oldest = F.asOfFrom([{ sourceKind: 'csv', createdAt: T0, updatedAt: T0, lastRefreshedAt: T2 }, null, { sourceKind: 'csv', createdAt: T0, updatedAt: T0, lastRefreshedAt: T1 }]);
ok('asOfFrom: a figure of several datasets is as old as its stalest (and a missing one is skipped)', oldest?.at === T1 && oldest.mode === 'extract' && Object.keys(oldest).length === 2, JSON.stringify(oldest));
ok('asOfFrom: nothing datable → no asOf, never a guess', F.asOfFrom([]) === undefined && F.asOfFrom([null]) === undefined);
ok('utcLabel: the time the AI facts state, in UTC and labelled so', F.utcLabel(T2) === 'Oct 9, 2026, 1:00 AM UTC', F.utcLabel(T2));

// ── HTTP harness ──────────────────────────────────────────────────────────────

function client(base: string) {
  return async (channel: string, payload?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json' }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
  };
}

interface Tab { events: { channel: string; data: any }[]; close(): void } // any: the event's payload

/** /api/events like a browser tab's EventSource. */
function openTab(base: string): Promise<Tab> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: u.hostname, port: Number(u.port), path: `/api/events?client=${randomUUID()}` }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`/api/events ${res.statusCode}`));
      const tab: Tab = { events: [], close: () => req.destroy() };
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          tab.events.push({ channel: ev ? ev[1] : 'message', data: data ? wire.decode(data[1]) : undefined });
        }
      });
      res.on('error', () => undefined);
      resolve(tab);
    });
    req.on('error', reject);
  });
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app: FastifyInstance = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
  const call = client(base);
  const tabs: Tab[] = [];
  try {
    const pid: string = (await call('projects:create', { name: 'Freshness' })).body.id;
    const cols = [{ name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }];
    // `Orders`: imported once, no origin. `Feed`: a query over `Feed base` — re-fetchable
    // with no network; `Feed 2` a query over `Feed`, re-run downstream of it.
    const s = await context.runInContext(dev, 'seed', async () => {
      const orders = await datasets.saveDataset(pid, {
        name: 'Orders', sourceKind: 'csv', columns: cols,
        rows: [['North', 5], ['South', 7], ['North', 6], ['South', 8], ['North', 4], ['South', 9], ['North', 5], ['South', 7]],
      });
      const feedBase = await datasets.saveDataset(pid, { name: 'Feed base', sourceKind: 'csv', columns: cols, rows: [['North', 100], ['South', 200]] });
      await sleep(15); // Feed's time strictly after Orders'
      const feed = await datasets.saveDataset(pid, {
        name: 'Feed', sourceKind: 'sql', columns: cols, rows: [['North', 100], ['South', 200]],
        origin: { kind: 'sql', sql: 'SELECT region, amount FROM "Feed base"', deps: [feedBase!.id] },
      } as never);
      const feed2 = await datasets.saveDataset(pid, {
        name: 'Feed 2', sourceKind: 'sql', columns: cols, rows: [['North', 100], ['South', 200]],
        origin: { kind: 'sql', sql: 'SELECT region, amount FROM "Feed"', deps: [feed!.id] },
      } as never);
      const m = await metrics.saveMetric(pid, { name: 'Feed total', datasetId: feed!.id, definition: { column: 'amount', aggregation: 'sum' } } as never);
      const v = await visuals.saveVisual(pid, { name: 'Feed by region', datasetId: feed!.id, chartType: 'bar', encoding: SALES } as never);
      return { orders: orders!.id, base: feedBase!.id, feed: feed!.id, feed2: feed2!.id, metric: m!.id, visual: v!.id };
    });
    const meta = (id: string) => context.runInContext(dev, 'meta', () => datasets.getDatasetMeta(pid, id));
    const feedAt = (await meta(s.feed))!.lastRefreshedAt as string;
    const ordersAt = (await meta(s.orders))!.createdAt;
    ok('fixture: a query dataset is as of its import, a file one has no refresh time', typeof feedAt === 'string' && (await meta(s.orders))!.lastRefreshedAt === undefined && ordersAt < feedAt);

    // ── 2. Every door ───────────────────────────────────────────────────
    const want = { at: new Date(feedAt).toISOString(), mode: 'extract' };
    const isWant = (a: unknown) => JSON.stringify(a) === JSON.stringify(want);
    const vd = await call('visual:data', { projectId: pid, datasetId: s.feed, encoding: SALES });
    ok('visual:data: the figure and its asOf = the dataset\'s last refresh', vd.body.ok && isWant(vd.body.asOf) && vd.body.data.series[0].values.join() === '100,200', JSON.stringify(vd.body.asOf));
    const vb = await call('visual:dataBatch', { projectId: pid, items: [{ datasetId: s.feed, encoding: SALES }, { datasetId: s.orders, encoding: SALES }] });
    ok('visual:dataBatch: each chart dated by its own dataset', isWant(vb.body[0].asOf) && vb.body[1].asOf?.at === new Date(ordersAt).toISOString(), JSON.stringify(vb.body.map((r: { asOf: unknown }) => r.asOf)));
    const pv = await call('visual:preview', { projectId: pid, datasetId: s.feed, encoding: SALES, filters: [] });
    ok('visual:preview: the builder\'s preview is dated too', pv.body.ok && isWant(pv.body.asOf), JSON.stringify(pv.body.asOf));
    const dm = await call('dashboard:metric', { projectId: pid, datasetId: s.feed, column: 'amount', aggregation: 'sum' });
    ok('dashboard:metric: a column KPI is dated', dm.body.ok && dm.body.value === 300 && isWant(dm.body.asOf), JSON.stringify(dm.body));
    const mv = await call('metric:values', { projectId: pid, ids: [s.metric] });
    ok('metric:values: a saved metric is dated by its dataset', mv.body[0].ok && mv.body[0].value === 300 && isWant(mv.body[0].asOf), JSON.stringify(mv.body));
    const tiles = await call('analysis:tiles', {
      projectId: pid,
      items: [
        { kind: 'visual', datasetId: s.feed, encoding: SALES },
        { kind: 'metric', datasetId: s.feed, column: 'amount', aggregation: 'sum' },
        { kind: 'metric', datasetId: s.feed, column: 'amount', aggregation: 'sum', metricId: s.metric },
        { kind: 'stats', spec: { kind: 'groups', datasetId: s.orders, outcome: 'amount', group: 'region' } },
      ],
    });
    ok('analysis:tiles: chart, column KPI and saved-metric KPI tiles carry it through the batch',
      tiles.body.slice(0, 3).every((t: { ok: boolean; asOf: unknown }) => t.ok && isWant(t.asOf)), JSON.stringify(tiles.body.slice(0, 3).map((t: { asOf: unknown }) => t.asOf)));
    ok('analysis:tiles: a statistics tile is dated by its spec\'s dataset', tiles.body[3].ok && tiles.body[3].asOf?.at === new Date(ordersAt).toISOString(), JSON.stringify(tiles.body[3]).slice(0, 200));
    const card = await call('answer:card', { projectId: pid, spec: { datasetId: s.feed, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'bar', title: 'Feed' } });
    ok('answer:card: an answer is dated', card.body.ok && isWant(card.body.asOf), JSON.stringify(card.body).slice(0, 200));
    const st = await call('dashboard:asOfStamps', { projectId: pid, datasetIds: [s.feed, s.orders], metricIds: [] });
    ok('dashboard:asOfStamps: `latest` is the sheet\'s stalest dataset', st.body.ok && st.body.latest?.at === new Date(ordersAt).toISOString(), JSON.stringify(st.body));
    const stM = await call('dashboard:asOfStamps', { projectId: pid, datasetIds: [], metricIds: [s.metric] });
    ok('dashboard:asOfStamps: a metric counts with its dataset', isWant(stM.body.latest), JSON.stringify(stM.body));
    const gone = await call('visual:data', { projectId: pid, datasetId: randomUUID(), encoding: SALES });
    ok('a refusal carries no asOf (negative control)', gone.body.ok === false && !('asOf' in gone.body), JSON.stringify(gone.body));

    // ── 3. Never cached ─────────────────────────────────────────────────
    // A refresh writes the table, THEN its markers. A marker moving with no data
    // change keeps the answer-cache key (updatedAt) — the figure is reused — yet
    // the caption must move with it.
    const unmarked = (await meta(s.feed))!;
    await sleep(15);
    await context.runInContext(dev, 'mark', () => datasets.markRefresh(pid, s.feed, 'ok', null));
    const marked = (await meta(s.feed))!;
    const again = await call('visual:data', { projectId: pid, datasetId: s.feed, encoding: SALES });
    ok('cache: the figure is the cached one (updatedAt unchanged) and the caption moved with the marker',
      marked.updatedAt === unmarked.updatedAt && again.body.asOf?.at === new Date(marked.lastRefreshedAt as string).toISOString() && again.body.asOf.at !== want.at
        && again.body.data.series[0].values.join() === '100,200', JSON.stringify([again.body.asOf, want]));

    // ── 4. Pushed ───────────────────────────────────────────────────────
    const tab = await openTab(base);
    tabs.push(tab);
    const refreshed = () => tab.events.filter((e) => e.channel === 'hub:dataset-refreshed');
    // Snapshots are kept for a scheduled dataset; the base table moves.
    await context.runInContext(dev, 'sched', () => datasets.setAutoRefresh(pid, s.feed, { every: 'hourly', lastAutoAt: new Date().toISOString() }));
    const beforeRefresh = (await meta(s.feed))!;
    await context.runInContext(dev, 'edit', async () => {
      const b = await datasets.getDataset(pid, s.base);
      await datasets.persist(pid, { ...b!, rows: [['North', 100], ['South', 200], ['East', 50]], rowCount: 3 } as never);
    });
    await sleep(15);
    const rf = await call('dataset:refresh', { projectId: pid, id: s.feed });
    ok('refresh: dataset:refresh succeeded', rf.body?.ok === true, JSON.stringify(rf.body).slice(0, 200));
    await until(() => refreshed().length >= 2, 5000);
    await sleep(300);
    const evs = refreshed();
    const ofFeed = evs.filter((e) => e.data?.datasetId === s.feed);
    const ofFeed2 = evs.filter((e) => e.data?.datasetId === s.feed2);
    ok('push: the refreshed dataset reaches the reader\'s tab exactly once, as the scheduler\'s payload',
      ofFeed.length === 1 && JSON.stringify(ofFeed[0].data) === JSON.stringify({ projectId: pid, datasetId: s.feed, name: 'Feed', ok: true, rowsBefore: 2, rowsAfter: 3 }), JSON.stringify(evs.map((e) => e.data)));
    ok('push: the query re-run downstream of it is announced too, once', ofFeed2.length === 1 && ofFeed2[0].data.ok === true && ofFeed2[0].data.rowsAfter === 3, JSON.stringify(ofFeed2.map((e) => e.data)));
    const after = await call('visual:data', { projectId: pid, datasetId: s.feed, encoding: SALES });
    ok('refresh: the next read has the new figure and the new time', after.body.data.series[0].values.join() === '100,200,50'
      && after.body.asOf.at === new Date((await meta(s.feed))!.lastRefreshedAt as string).toISOString() && after.body.asOf.at > again.body.asOf.at, JSON.stringify([after.body.data, after.body.asOf]));
    // As of the kept snapshot: dated with the snapshot's time, not today's.
    const past = new Date(Date.parse(beforeRefresh.lastRefreshedAt as string) + 1).toISOString();
    const old = await call('visual:data', { projectId: pid, datasetId: s.feed, encoding: SALES, asOf: past });
    ok('as of a snapshot: the old figure, dated with the snapshot\'s own time', old.body.ok && old.body.data.series[0].values.join() === '100,200'
      && old.body.asOf?.at === new Date(beforeRefresh.lastRefreshedAt as string).toISOString(), JSON.stringify([old.body.data?.series, old.body.asOf]));

    // A refresh that fails (a dataset with nothing to re-fetch) is not announced.
    const n = refreshed().length;
    const bad = await call('dataset:refresh', { projectId: pid, id: s.orders });
    await sleep(400);
    ok('push: a failed refresh is not announced (negative control)', bad.body.ok === false && refreshed().length === n, JSON.stringify(bad.body));

    // The scheduler's tick refreshes through the same door — announced by it, once.
    await context.runInContext(dev, 'unstamp', () => datasets.setAutoRefresh(pid, s.feed, { every: 'hourly', lastAutoAt: new Date(0).toISOString() }));
    const ticked = await context.runInContext(dev, 'tick', () => scheduler.tickNow());
    await until(() => refreshed().filter((e) => e.data?.datasetId === s.feed).length >= 2, 5000);
    await sleep(300);
    ok('push: a scheduled refresh is announced by refreshAsJob too — once', ticked.some((o) => o.datasetId === s.feed && o.ok)
      && refreshed().filter((e) => e.data?.datasetId === s.feed).length === 2, JSON.stringify(refreshed().map((e) => e.data)));
  } finally {
    for (const t of tabs) t.close();
    await app.close();
  }
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
