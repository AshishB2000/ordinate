// What Live costs, counted and bounded (docs/live-data/00-plan.md L2.7, D9,
// R-L2) — the executor in server mode against the fake warehouse, WITHOUT
// Postgres: this pod's in-memory count. scripts/test-liveUsage-db.ts runs the
// same rules on Postgres, across two pods.
//
//   count         every warehouse statement is one query on its connection's
//                 row for the UTC day — a KPI, an answer, its period MAX(); a
//                 cache hit or a joined flight is none
//   bytes         the warehouse's own figure, summed per row; a warehouse that
//                 reports none leaves the row's bytes null, never 0; BigQuery's
//                 reply → `bytes` (totalBytesBilled, else totalBytesProcessed)
//   limit         LIVE_DAILY_QUERY_LIMIT: past it nothing reaches the
//                 warehouse; a cached question is served stale, an uncached one
//                 is a typed refusal with its catalog sentence — never empty;
//                 refusals are counted; 0 = no limit; a new UTC day starts over
//   notice        the org's first refusal of a day: one push to its admins and
//                 one log line — NEGATIVE CONTROL: the second and third send
//                 nothing; another org's, and the next day's, send their own
//   public floor  LIVE_MIN_CACHE_AGE_PUBLIC_SEC inside a /p/ page's request —
//                 through the real route — and nowhere else. NEGATIVE CONTROL:
//                 a signed-in request at maxCacheAgeSec 0 asks the warehouse
//                 every time, even with a public answer fresh in the cache
//   one door      runLiveBound is called from warehouse() (liveWarehouse.ts) and
//                 nowhere else in src/ (NEGATIVE CONTROL: a planted caller is
//                 found), so a later profile or DISTINCT is limited and counted
//   fail closed   a count that cannot be written (Postgres down) sends nothing:
//                 the stale answer, else a typed failure, the reason logged
//   hang-up       every asker gone while its statement was being counted: not
//                 sent (NEGATIVE CONTROL: an asker still waiting → sent)
//   admin         admin:liveUsage's reply: names, labels, today, the share used
//   env           both settings validated at startup, with their defaults
//
//   npm run build:ts && node scripts/test-liveUsage.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { VizMeasure } from '../src/analysis/visuals';
import * as H from './liveQueryHarness';
import { fakeTransport, fixture, happy, isQuery, isResults, makeKey, ctxFor } from './bigqueryFake';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');
const usage: typeof import('../src/server/live/usageStore') = require('../src/server/live/usageStore');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const notice: typeof import('../src/server/live/limitNotice') = require('../src/server/live/limitNotice');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const hosted: typeof import('../src/publish/hosted') = require('../src/publish/hosted');
const adminLive: typeof import('../src/server/admin/liveUsage') = require('../src/server/admin/liveUsage');
const bq: typeof import('../src/connectors/bigquery') = require('../src/connectors/bigquery');
const bqShape: typeof import('../src/connectors/bigqueryShape') = require('../src/connectors/bigqueryShape');
const liveRun: typeof import('../src/connectors/liveRun') = require('../src/connectors/liveRun');

const { lq, fake, queryCache, budget, context, ORG_A, ORG_B } = H;
const M = (column: string, aggregation: VizMeasure['aggregation']): VizMeasure => ({ column, aggregation });
const kpi = (column: string, aggregation: 'sum' | 'avg' | 'min' | 'max' | 'count' = 'sum') => ({ column, aggregation });
const show = (v: unknown): string => JSON.stringify(v);
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const DAY_MS = 86_400_000;
let clock = Date.UTC(2026, 9, 9, 12, 0, 0);
queryCache.setClockForTest(() => clock);
usage.setUsageClockForTest(() => clock);

// Every push, as the cross-pod fan-out would carry it (this pod has no open stream).
const pushes: { org: string; user?: string; channel: string; data: unknown }[] = [];
sse.setFanOut((t, channel, data) => pushes.push({ org: t.org, user: t.user, channel, data: wire.decode(data) }));
const limitPushes = (org: string) => pushes.filter((p) => p.channel === notice.LIMIT_CHANNEL && p.org === org);

function reset(): void {
  queryCache.clear();
  H.fakeMod.resetFake();
  usage.clearMemoryForTest();
  delete process.env.LIVE_DAILY_QUERY_LIMIT;
  delete process.env.LIVE_MIN_CACHE_AGE_PUBLIC_SEC;
}

/** The caller's row for `connId` today (or `day`). */
async function rowOf(who: typeof ORG_A, connId: string, day = usage.utcDay()): Promise<import('../src/server/live/usageStore').UsageRow | undefined> {
  return (await H.as(who, () => usage.readUsage(null, day))).find((r) => r.connectionId === connId && r.day === day);
}

async function counting(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const D = s.liveId;
  reset();
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 0));
  for (let i = 0; i < 3; i++) await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('amt'), []));
  await H.as(ORG_A, () => lq.liveAnswer(P, { datasetId: D, category: 'region', measures: [M('amt', 'sum')], filters: [{ column: 'd', period: 'last_quarter' }], chartType: 'bar', title: 'a' }));
  let r = await rowOf(ORG_A, s.connId);
  ok('count: every statement is one query on its connection — 3 KPIs at age 0, an answer AND its MAX()', fake.calls.length === 5 && r?.queries === 5 && r.refused === 0 && r.projectId === P, show(r));
  ok('bytes: a warehouse that reports none leaves the row\'s bytes null — "not reported", never 0', r?.bytes === null);

  fake.hook = async () => { await new Promise((res) => setTimeout(res, 40)); return undefined; };
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => H.as(ORG_A, () => lq.liveMetric(P, D, kpi('qty', 'avg'), []))));
  fake.hook = null;
  r = await rowOf(ORG_A, s.connId);
  ok('count: five identical asks sharing one flight are ONE query', five.every((x) => x.ok) && fake.calls.length === 6 && r?.queries === 6, show(r));
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 300));
  await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('tier', 'max'), []));
  await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('tier', 'max'), []));
  r = await rowOf(ORG_A, s.connId);
  ok('count: a cache hit is no query', fake.calls.length === 7 && r?.queries === 7, show(r));
  ok('one door: the count equals the statements the warehouse saw', r?.queries === fake.calls.length);

  fake.billedBytes = 1_234_567;
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 0));
  for (let i = 0; i < 3; i++) await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('amt', 'min'), []));
  await tick();
  r = await rowOf(ORG_A, s.connId);
  ok('bytes: the warehouse\'s own figure is summed per row (3 × 1,234,567)', r?.bytes === 3 * 1_234_567 && r.queries === 10, show(r));
  ok('isolation: the other org has no row (orgKey)', (await H.as(ORG_B, () => usage.readUsage(null, usage.utcDay()))).length === 0);
  // The import case: the same connection id in two orgs is two rows, never one shared count.
  const twin = { projectId: P, connectionId: s.connId };
  await H.as(ORG_B, () => usage.admit(null, twin, 0));
  ok('isolation: the same ids in another org count on their own row', (await rowOf(ORG_B, s.connId))?.queries === 1 && (await rowOf(ORG_A, s.connId))?.queries === 10);
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 300));
}

async function limit(a: H.OrgSetup, b: H.OrgSetup): Promise<void> {
  const P = a.projectId;
  const D = a.liveId;
  reset();
  pushes.length = 0;
  process.env.LIVE_DAILY_QUERY_LIMIT = '4';
  for (const [c, g] of [['amt', 'sum'], ['qty', 'sum'], ['amt', 'max'], ['qty', 'max']] as const) await H.as(ORG_A, () => lq.liveMetric(P, D, kpi(c, g), []));
  ok('limit: under it every question reaches the warehouse', fake.calls.length === 4);
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 0)); // every cached answer is now too old for a viewer
  const before = H.liveCounts();
  const logged = await H.capturingWarn(async () => {
    const stale = await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('amt', 'sum'), []));
    await tick();
    return stale;
  });
  const stale = logged.value;
  ok('limit: past it a cached question is served STALE, with no warehouse call', stale.ok && stale.asOf.stale === true && stale.asOf.cached === true && fake.calls.length === 4, show(stale));
  const none = await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('amt', 'min'), []));
  ok('limit: an uncached question is a typed refusal with the catalog sentence — no figure, never empty',
    !none.ok && none.code === 'live_refused' && none.reason === 'dailyLimit' && none.error === H.msg.liveDailyLimit('4') && !('value' in none) && fake.calls.length === 4, show(none));
  ok('limit: the trace says stale and refused, not failed', H.liveCounts().stale - before.stale === 1 && H.liveCounts().refused - before.refused === 1 && H.liveCounts().failed === before.failed);
  let r = await rowOf(ORG_A, a.connId);
  ok('limit: the day\'s row holds 4 queries and the 2 refusals', r?.queries === 4 && r.refused === 2, show(r));

  // ── The notice: once per org per UTC day ──
  const first = limitPushes('acme');
  ok('notice: the first refusal pushes ONE notice to the org\'s admins (no Postgres: the org\'s tabs) — the day and the limit, nothing else',
    first.length === 1 && first[0].user === undefined && show(first[0].data) === show({ day: '2026-10-09', limit: 4 }), show(first));
  ok('notice: …and writes one log line naming the limit', logged.lines.filter((l) => l.includes('LIVE_DAILY_QUERY_LIMIT')).length === 1 && logged.lines.some((l) => l.includes('org acme')), show(logged.lines));
  const quiet = await H.capturingWarn(async () => {
    await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('qty', 'min'), []));
    await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('qty', 'sum'), []));
    await tick();
  });
  ok('notice NEGATIVE CONTROL: the second and third refusals of the day send nothing, and log nothing',
    limitPushes('acme').length === 1 && !quiet.lines.some((l) => l.includes('LIVE_DAILY_QUERY_LIMIT')) && (await rowOf(ORG_A, a.connId))?.refused === 4);
  await H.as(ORG_B, () => usage.admit(null, { projectId: b.projectId, connectionId: b.connId }, 4)); // globex's own count: 1
  process.env.LIVE_DAILY_QUERY_LIMIT = '1';
  await H.as(ORG_B, () => lq.liveMetric(b.projectId, b.liveId, kpi('amt'), []));
  await tick();
  ok('notice: another org\'s first refusal is its own notice, to its own tabs', limitPushes('globex').length === 1 && limitPushes('acme').length === 1);

  process.env.LIVE_DAILY_QUERY_LIMIT = '0';
  const free = await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('amt', 'avg'), []));
  ok('limit 0: no limit — the warehouse is asked past the old one', free.ok && !free.asOf.stale && fake.calls.length === 5);
  process.env.LIVE_DAILY_QUERY_LIMIT = '5';
  const atFive = await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('tier', 'avg'), []));
  ok('limit: re-read per statement — 5 counted, the next is refused', !atFive.ok && atFive.reason === 'dailyLimit' && fake.calls.length === 5);

  clock += DAY_MS; // 2026-10-10, UTC
  const tomorrow = await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('tier', 'avg'), []));
  r = await rowOf(ORG_A, a.connId);
  ok('new day: the count starts over on a new row', tomorrow.ok && !tomorrow.asOf.stale && fake.calls.length === 6 && r?.day === '2026-10-10' && r.queries === 1 && r.refused === 0, show(r));
  ok('new day: yesterday\'s row is kept as it was', (await rowOf(ORG_A, a.connId, '2026-10-09'))?.queries === 5);
  process.env.LIVE_DAILY_QUERY_LIMIT = '1';
  await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('tier', 'min'), []));
  await tick();
  const second = limitPushes('acme');
  ok('notice: the next day\'s first refusal sends one more, for that day', second.length === 2 && show(second[1].data) === show({ day: '2026-10-10', limit: 1 }), show(second));
  clock -= DAY_MS;
  delete process.env.LIVE_DAILY_QUERY_LIMIT;
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 300));
}

async function failClosed(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const D = s.liveId;
  reset();
  await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('amt', 'sum'), []));
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 0));
  // A Postgres that cannot be reached: the count cannot be written.
  const down = { connect: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); } } as unknown as import('pg').Pool;
  usage.useLiveUsageDb(down);
  try {
    const logged = await H.capturingWarn(async () => [
      await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('amt', 'sum'), [])),
      await H.as(ORG_A, () => lq.liveMetric(P, D, kpi('qty', 'min'), [])),
    ]);
    const [stale, none] = logged.value;
    ok('fail closed: with the count unwritable no statement is sent — the cached answer stale, else a typed failure',
      fake.calls.length === 1 && stale.ok && stale.asOf.stale === true && !none.ok && none.code === 'live_failed', show(logged.value));
    ok('fail closed: …and the reason is in the server log', logged.lines.some((l) => l.includes('the usage count') && l.includes('ECONNREFUSED')));
  } finally {
    usage.useLiveUsageDb(null);
    await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 300));
  }
}

async function hangUpWhileCounted(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const D = s.liveId;
  reset();
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 0));
  // An admission that takes its time (a slow Postgres): the asker hangs up while it is pending.
  const slow = (g: ReturnType<typeof H.gate>, seen: { n: number }) => async () => {
    seen.n += 1;
    await g.wait();
    return { ok: true as const };
  };
  try {
    const g = H.gate();
    const seen = { n: 0 };
    budget.setDailyCheckForTest(slow(g, seen));
    const ac = new AbortController();
    const pending = H.as(ORG_A, () => lq.liveMetric(P, D, kpi('amt', 'sum'), []), ac.signal);
    await H.until(() => seen.n === 1);
    ac.abort();
    const gone = await pending;
    g.open();
    await H.until(() => lq.flightsInAir() === 0);
    await tick();
    ok('hang-up while counted: every asker gone before the admission returned → the statement is not sent',
      seen.n === 1 && !gone.ok && gone.code === 'live_cancelled' && fake.calls.length === 0, show({ gone, calls: fake.calls.length }));
    // NEGATIVE CONTROL: the same slow admission with the asker still there sends it.
    const g2 = H.gate();
    const seen2 = { n: 0 };
    budget.setDailyCheckForTest(slow(g2, seen2));
    const before = fake.calls.length;
    const stays = H.as(ORG_A, () => lq.liveMetric(P, D, kpi('amt', 'sum'), []));
    await H.until(() => seen2.n === 1);
    g2.open();
    const got = await stays;
    ok('hang-up NEGATIVE CONTROL: with the asker still waiting the same admission sends the statement', got.ok && fake.calls.length === before + 1, show(got));
  } finally {
    budget.setDailyCheckForTest(null);
    await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 300));
  }
}

async function publicFloor(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const D = s.liveId;
  reset();
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 0));
  const signedIn = () => H.as(ORG_A, () => lq.liveMetric(P, D, kpi('qty'), []));
  let req = 0;
  const onPage = () => context.runAsPublished(ORG_A, `p${++req}`, () => lq.liveMetric(P, D, kpi('qty'), []));
  ok('floor: 60 s inside a published page\'s request, 0 in any other', context.runAsPublished(ORG_A, 'f', () => budget.cacheAgeFloorSec()) === 60
    && context.runInContext(ORG_A, 'f', () => budget.cacheAgeFloorSec()) === 0 && budget.cacheAgeFloorSec() === 0);

  const fetched = clock;
  const a = await signedIn();
  const p1 = await onPage();
  ok('floor: a /p/ request at maxCacheAgeSec 0 is served the answer a viewer fetched a moment ago — no warehouse call',
    a.ok && p1.ok && p1.value === a.value && p1.asOf.cached === true && fake.calls.length === 1, show(p1));
  clock = fetched + 59_000;
  const p2 = await onPage();
  ok('floor: still served from cache at 59 s', p2.ok && p2.asOf.cached === true && fake.calls.length === 1);
  clock = fetched + 60_000;
  const p3 = await onPage();
  ok('floor: at 60 s the page asks the warehouse once', p3.ok && !p3.asOf.cached && fake.calls.length === 2);
  for (let i = 0; i < 3; i++) await signedIn();
  ok('floor NEGATIVE CONTROL: a signed-in request at maxCacheAgeSec 0 goes to the warehouse EVERY time, a fresh public answer notwithstanding', fake.calls.length === 5, String(fake.calls.length));
  const p4 = await onPage();
  ok('floor: …and the page then serves the newest of those', p4.ok && p4.asOf.cached === true && fake.calls.length === 5);

  process.env.LIVE_MIN_CACHE_AGE_PUBLIC_SEC = '0';
  await onPage();
  await onPage();
  ok('floor 0: no floor — the page follows the dataset\'s own age 0', fake.calls.length === 7);
  delete process.env.LIVE_MIN_CACHE_AGE_PUBLIC_SEC;
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 300));
  await onPage(); // the last answer was stored under a floor of 0: asked again, kept for 5 minutes
  clock += 120_000; // past the floor, inside the dataset's own 5 minutes
  const p5 = await onPage();
  ok('floor: a dataset age longer than the floor is kept on a page', p5.ok && p5.asOf.cached === true && fake.calls.length === 8, String(fake.calls.length));

  // Through the real route: GET /p/<id>/ reads the site inside runAsPublished. The
  // site lookup is replaced by one that asks the Live question a page would.
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 0));
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: H.DATA, ORDINATE_ENV: 'dev' }), undefined, () => ORG_A);
  const realGetSite = hosted.getSite;
  type Seen = { published: boolean; floor: number; reply: Awaited<ReturnType<typeof lq.liveMetric>> };
  let seen: Seen | null = null;
  const lastSeen = (): Seen | null => seen; // what the stub saw (a closure's write, invisible to narrowing)
  try {
    await signedIn();
    const calls = fake.calls.length;
    (hosted as { getSite: typeof hosted.getSite }).getSite = async () => {
      seen = { published: context.isPublishedRequest(), floor: budget.cacheAgeFloorSec(), reply: await lq.liveMetric(P, D, kpi('qty'), []) };
      return null;
    };
    const res = await app.inject({ method: 'GET', url: `/p/${randomUUID()}/` });
    const got = lastSeen();
    ok('route: GET /p/… runs as a published page\'s request — the floor holds there and the figure came from cache',
      res.statusCode === 404 && got !== null && got.published && got.floor === 60 && got.reply.ok && got.reply.asOf.cached === true && fake.calls.length === calls, show(got));
    seen = null;
    await H.as(ORG_A, () => hosted.getSite(randomUUID()));
    const plain = lastSeen();
    ok('route NEGATIVE CONTROL: the same read in an ordinary request is not a page\'s — no floor, the warehouse is asked',
      plain !== null && !plain.published && plain.floor === 0 && fake.calls.length === calls + 1);
  } finally {
    (hosted as { getSite: typeof hosted.getSite }).getSite = realGetSite;
    // Not app.close(): its onClose shuts the org DuckDB workers down asynchronously, and a process that
    // exits while one is still closing can abort (Napi::Error — docs/phase-7-web/99-retro.md, seen
    // once here under load). finish() exits with them idle, as the other live suites do.
  }
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, D, 300));
}

async function adminReply(s: H.OrgSetup): Promise<void> {
  reset();
  fake.billedBytes = 1_610_612_736; // 1.5 GiB a statement
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(s.projectId, s.liveId, 0));
  for (let i = 0; i < 3; i++) await H.as(ORG_A, () => lq.liveMetric(s.projectId, s.liveId, kpi('amt'), []));
  await tick();
  const u = await H.as(ORG_A, () => adminLive.liveUsage(12));
  const row = u.rows[0];
  ok('admin: one row per day and connection, named by the connection, its connector and its project',
    u.rows.length === 1 && row.connectionId === s.connId && row.connection === 'Fake warehouse' && row.connector === 'Fake warehouse (tests)' && row.project === 'Live executor', show(u));
  ok('admin: the figures are the server\'s — today\'s count, the share of the limit, the byte label',
    u.today === '2026-10-09' && u.limit === 12 && u.todayQueries === 3 && u.todayRefused === 0 && u.usedLabel === '25%'
      && row.bytes === 3 * 1_610_612_736 && row.bytesLabel === '4.5 GB', show(u));
  ok('admin: without Postgres the counts say they are this pod\'s, over a 30-day window', u.perPod === true && u.days === 30);
  const none = await H.as(ORG_A, () => adminLive.liveUsage(0));
  ok('admin: no limit → no share', none.usedLabel === null && none.limit === 0);
  const tiny = await H.as(ORG_A, () => adminLive.liveUsage(10_000));
  ok('admin: a share under 1% is "<1%", never "0%"; one short of the limit is never "100%"', tiny.usedLabel === '<1%' && (await H.as(ORG_A, () => adminLive.liveUsage(3))).usedLabel === '100%'
    && [[0, 300], [1, 300], [150, 300], [299, 300], [400, 300]].map(([u, l]) => adminLive.percentLabel(u, l)).join() === '0%,<1%,50%,>99%,100%');
  ok('admin: the other org sees none of these rows', (await H.as(ORG_B, () => adminLive.liveUsage(12))).rows.length === 0);
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(s.projectId, s.liveId, 300));
}

/** Files under src/ whose code (comments stripped) matches `re`, with the count. */
function callers(files: ReadonlyMap<string, string>, re: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const [file, text] of files) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const n = (code.match(re) ?? []).length;
    if (n) out.set(file, n);
  }
  return out;
}

function oneDoor(): void {
  const root = path.join(__dirname, '..');
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
    }
  };
  walk('src');
  const RUN_LIVE = /(?<!function )\brunLiveBound\(/g;
  const RUN_BOUND = /\.runBound\(/g;
  const live = callers(files, RUN_LIVE);
  ok('one door: runLiveBound is called once in src/, from warehouse() (liveWarehouse.ts)', live.size === 1 && live.get('src/engine/live/liveWarehouse.ts') === 1, show([...live]));
  const raw = callers(files, RUN_BOUND);
  ok('one door: a connector\'s live.runBound is called from liveRun.ts alone', raw.size === 1 && raw.get('src/connectors/liveRun.ts') === 1, show([...raw]));
  const body = files.get('src/engine/live/liveWarehouse.ts') ?? '';
  const door = body.slice(body.indexOf('export async function warehouse('), body.indexOf('\n}\n', body.indexOf('export async function warehouse(')));
  ok('one door: …inside warehouse(), after the slot and the daily check', /acquire\([\s\S]*checkDaily\([\s\S]*runLiveBound\(/.test(door));
  ok('one door: warehouse() is exported from the executor, for L2.4\'s lookups and L2.5\'s profile', lq.warehouse === require('../src/engine/live/liveWarehouse').warehouse && typeof lq.LiveCallError === 'function');
  const planted = new Map(files);
  planted.set('src/engine/live/profile.ts', 'export async function sample() { return runLiveBound(def, values, secrets, sql, [], opts); }');
  planted.set('src/ipc/distinct.ts', 'const r = await def.live!.runBound(ctx, sql, params);');
  ok('one door NEGATIVE CONTROL: a statement sent around the executor is found', callers(planted, RUN_LIVE).has('src/engine/live/profile.ts') && callers(planted, RUN_BOUND).has('src/ipc/distinct.ts'));
}

async function bigqueryBytes(): Promise<void> {
  ok('bigquery: totalBytesBilled first, else totalBytesProcessed, else nothing — never a guess',
    bqShape.billedBytesOf({ totalBytesBilled: '10485760', totalBytesProcessed: '20971520' }) === 10_485_760
      && bqShape.billedBytesOf({ totalBytesProcessed: '1234' }) === 1234 && bqShape.billedBytesOf({}) === undefined
      && bqShape.billedBytesOf({ totalBytesBilled: '-1' }) === undefined && bqShape.billedBytesOf({ totalBytesBilled: 'lots', totalBytesProcessed: '7' }) === 7
      && bqShape.billedBytesOf({ totalBytesBilled: '0' }) === 0);
  const key = makeKey();
  const def = bq.CONNECTORS[0];
  const run = async (route: Parameters<typeof happy>[0]) => {
    const f = fakeTransport(happy(route));
    bq.setTransport(f.transport);
    try {
      return await def.live!.runBound({ ...ctxFor(key), costTag: 'live' }, 'select region from sales.orders', []);
    } finally {
      bq.setTransport(null);
    }
  };
  const billed = await run((c) => (isQuery(c) ? { json: { ...(fixture('query-types.json') as object), totalBytesBilled: '10485760' } } : null));
  ok('bigquery: a finished jobs.query reply → the rows carry its totalBytesBilled', billed.ok && billed.bytes === 10_485_760, show(billed.ok && billed.bytes));
  const processed = await run(() => null);
  ok('bigquery: a reply with only totalBytesProcessed → that', processed.ok && processed.bytes === 20_971_520);
  let polls = 0;
  const paged = await run((c) => (isQuery(c) ? { json: fixture('query-incomplete.json') } : isResults(c) ? { json: fixture(++polls === 1 ? 'results-page1.json' : 'results-page2.json') } : null));
  ok('bigquery: a job finished by getQueryResults → its totalBytesProcessed, once (not per page)', paged.ok && paged.bytes === 1_288_490_188, show(paged.ok && paged.bytes));
  const through = await liveRun.runLiveBound({ ...def, live: { dialect: 'bigquery', runBound: async () => ({ ok: true, columns: [], rows: [], truncated: false, bytes: 42 }) } }, {}, {}, 'select 1', [], { signal: new AbortController().signal, timeoutMs: 1000 });
  const odd = await liveRun.runLiveBound({ ...def, live: { dialect: 'bigquery', runBound: async () => ({ ok: true, columns: [], rows: [], truncated: false, bytes: -3 }) } }, {}, {}, 'select 1', [], { signal: new AbortController().signal, timeoutMs: 1000 });
  ok('liveRun: the connector\'s byte figure passes through; a nonsense one is dropped', through.ok && through.bytes === 42 && odd.ok && odd.bytes === undefined);
}

function settings(): void {
  const base = { AUTH_MODE: 'dev', DATA_DIR: H.DATA };
  const refuses = (src: Record<string, string>, re: RegExp): boolean => {
    try { envMod.parseEnv({ ...base, ...src }); return false; } catch (e) { return e instanceof envMod.EnvError && re.test(e.message); }
  };
  ok('env: LIVE_DAILY_QUERY_LIMIT and LIVE_MIN_CACHE_AGE_PUBLIC_SEC are validated at startup',
    refuses({ LIVE_DAILY_QUERY_LIMIT: '-1' }, /LIVE_DAILY_QUERY_LIMIT/) && refuses({ LIVE_DAILY_QUERY_LIMIT: '10k' }, /LIVE_DAILY_QUERY_LIMIT/)
      && refuses({ LIVE_DAILY_QUERY_LIMIT: '1000000001' }, /LIVE_DAILY_QUERY_LIMIT/) && refuses({ LIVE_MIN_CACHE_AGE_PUBLIC_SEC: '1m' }, /LIVE_MIN_CACHE_AGE_PUBLIC_SEC/)
      && refuses({ LIVE_MIN_CACHE_AGE_PUBLIC_SEC: '2592001' }, /LIVE_MIN_CACHE_AGE_PUBLIC_SEC/));
  ok('env NEGATIVE CONTROL: the edges parse', !refuses({ LIVE_DAILY_QUERY_LIMIT: '0', LIVE_MIN_CACHE_AGE_PUBLIC_SEC: '0' }, /./)
    && !refuses({ LIVE_DAILY_QUERY_LIMIT: '1000000000', LIVE_MIN_CACHE_AGE_PUBLIC_SEC: '2592000' }, /./));
  ok('env: their defaults are 10,000 queries and 60 s; the names still come from env.ts',
    envMod.liveDailyQueryLimit(undefined) === 10_000 && envMod.liveMinCacheAgePublicSec('') === 60 && envMod.DEFAULT_LIVE_DAILY_QUERY_LIMIT === 10_000);
}

// AbortSignal.timeout's timer is unref'd; keep the loop alive while the suite runs.
const keepAlive = setInterval(() => undefined, 1000);

async function main(): Promise<void> {
  const a = await H.setupOrg(ORG_A);
  const b = await H.setupOrg(ORG_B);
  await counting(a);
  await limit(a, b);
  await adminReply(a);
  await failClosed(a);
  await hangUpWhileCounted(a);
  await publicFloor(a);
  oneDoor();
  await bigqueryBytes();
  settings();
}

main()
  .catch((e) => ok('live usage suite threw', false, e && (e as Error).stack))
  .finally(() => {
    clearInterval(keepAlive);
    sse.setFanOut(null);
    H.cleanup();
    finish();
  });
