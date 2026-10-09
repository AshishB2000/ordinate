// Fresh on ask at the doors (docs/live-data/00-plan.md L3.1): what a chart, a
// KPI, a statistics tile and an answer do when they ask a stale copy — over
// the real RPC route in server mode, the real job queue, the real incremental
// merge (DuckDB) and the real record. Only the SOURCE is faked: the
// connection's fetch (`runSavedText`) answers from tables held here, each with
// a delay, and the full re-fetch (`refreshConnectionInto`) is a spy that runs
// nothing — a call to it is a full refresh.
//
//   1. Dedupe and the wait: one dashboard load (`analysis:tiles`, 6 tiles on
//      one stale dataset + a control dataset) → ONE incremental pull, one push;
//      it lands inside FRESH_ON_ASK_WAIT_MS, so every tile and an answer card
//      shows the new rows and none says "refreshing". Two loads at the same
//      instant → still one pull. A second load at once → no pull.
//   2. Slow: the pull outlasts the wait → the old numbers, `asOf.refreshing`
//      and the copy's old time; another ask joins (no second pull); the push
//      (`hub:dataset-refreshed`) arrives when it lands; the next ask is fresh.
//   3. One pull per window: a failing source is pulled once, then `held` for
//      the rest of the window, then pulled again once the window has passed.
//   4. NEVER A FULL REFRESH: a dataset whose next run must be full is not
//      pulled; one whose fetched columns changed is skipped mid-run — no full
//      re-fetch, no error mark, nothing written. The direct incremental-only
//      refresh refuses three ways. NEGATIVE CONTROL: the same refresh in the
//      ordinary mode reaches the spy.
//   5. An as-of read never pulls.
//   6. The pull is detached: the asker's abort ends the WAIT (at once), not
//      the pull, which runs as the system with no request signal and no
//      display currency; the event loop keeps turning during a wait; one
//      request's datasets share ONE wait.
//
//   npm run build:ts && node scripts/test-freshOnAskDoors.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const connIpc: typeof import('../src/ipc/connections') = require('../src/ipc/connections');
const schedules: typeof import('../src/server/jobs/schedules') = require('../src/server/jobs/schedules');
const fresh: typeof import('../src/data/freshOnAsk') = require('../src/data/freshOnAsk');
const figure: typeof import('../src/data/figureAsOf') = require('../src/data/figureAsOf');
const refresh: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const asOfMod: typeof import('../src/data/asOf') = require('../src/data/asOf');
const fxQuery: typeof import('../src/ipc/fxQuery') = require('../src/ipc/fxQuery');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');

const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-freshdoors-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const inOrg = <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => context.runInContext(ADMIN, `t${++seq}`, fn, undefined, signal);

// ── The fake source ──────────────────────────────────────────────────────────
interface Seen { email: string; signal: boolean; asOf: string | undefined; fx: string }
/** `calls`: the runs that reached the source — each incremental run asks first with its cursor pushed down (a `query`); a refused one retries with the bare table, which is not counted again. */
interface Table { header: string[]; body: string[][]; delayMs: number; fail?: string; calls: number; seen: Seen[] }
const HEADER = ['id', 'updated', 'region', 'amount'];
const OLD = [['1', '1', 'North', '10'], ['2', '2', 'South', '20'], ['3', '3', 'North', '30']];
const NEW = [...OLD, ['4', '4', 'South', '5'], ['5', '5', 'East', '7']];
const tables = new Map<string, Table>();
const table = (name: string, t: Partial<Table> = {}): Table => {
  const v: Table = { header: HEADER, body: NEW, delayMs: 0, calls: 0, seen: [], ...t };
  tables.set(name, v);
  return v;
};
let projectId = '';
connIpc.runSavedText = (async (_p: string, _c: string, sel: { table?: string; query?: string }) => {
  const name = sel.table ?? /from\s+"?([a-z_]+)"?/i.exec(sel.query ?? '')?.[1] ?? '';
  const t = tables.get(name);
  if (!t) return { ok: false, error: `no table ${name}` };
  if (sel.query !== undefined) t.calls++;
  const c = context.ctx();
  t.seen.push({ email: c.user.email, signal: c.signal !== undefined, asOf: asOfMod.asOfIso(), fx: await fxQuery.fxTarget(projectId) });
  await sleep(t.delayMs);
  if (t.fail) return { ok: false, error: t.fail };
  return { ok: true, header: t.header, body: t.body, truncated: false };
}) as typeof connIpc.runSavedText;
let fullRefreshes = 0;
connIpc.refreshConnectionInto = (async () => {
  fullRefreshes++;
  return { ok: false, error: 'the full re-fetch spy' };
}) as typeof connIpc.refreshConnectionInto;
const pushes: { channel: string; payload: { datasetId: string; rowsBefore: number; rowsAfter: number } }[] = [];
schedules.pushToReaders = ((_p: string, channel: string, payload: unknown) => {
  pushes.push({ channel, payload: payload as (typeof pushes)[number]['payload'] });
}) as typeof schedules.pushToReaders;
const pushesFor = (id: string) => pushes.filter((p) => p.channel === 'hub:dataset-refreshed' && p.payload.datasetId === id);
async function pushed(id: string, n: number, ms = 8000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (pushesFor(id).length >= n) return true;
  return false;
}

(async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const foRecord: typeof import('../src/data/freshOnAskRecord') = require('../src/data/freshOnAskRecord');
  const cols = [{ name: 'id', type: 'number' as const }, { name: 'updated', type: 'number' as const }, { name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }];
  const rows = OLD.map((r) => [Number(r[0]), Number(r[1]), r[2], Number(r[3])]);
  const inc = (over: object = {}) => ({ enabled: true, cursorColumn: 'updated', keyColumn: 'id', lookback: 0, highWater: 3, runsSinceFull: 1, log: [], ...over });
  const ids = await inOrg(async () => {
    await projects.init();
    projectId = (await projects.createProject('Fresh doors')).id;
    const conn = await conns.saveConnection(projectId, { name: 'App DB', connectorId: 'postgres', values: { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' } });
    if (!conn) throw new Error('no connection');
    const out: Record<string, string> = {};
    for (const [key, opts] of [['orders', { fo: 300 }], ['plain', {}], ['twice', { fo: 300 }], ['slow', { fo: 300 }], ['flaky', { fo: 300 }],
      ['firstrun', { fo: 300, inc: { highWater: null } }], ['changed', { fo: 300 }], ['noinc', { noInc: true }], ['away', { fo: 300 }], ['loop', { fo: 300 }], ['seqa', { fo: 300 }], ['seqb', { fo: 300 }]] as const) {
      const o = opts as { fo?: number; inc?: object; noInc?: boolean };
      const d = await datasets.saveDataset(projectId, { name: key, sourceKind: 'postgres', columns: cols, rows, origin: { kind: 'connection', connId: conn.id, table: key } });
      if (!d) throw new Error('dataset not saved');
      if (!o.noInc) await datasets.writeIncremental(projectId, d.id, () => inc(o.inc));
      if (o.fo) {
        const r = await foRecord.setFreshOnAsk(projectId, d.id, { maxStalenessSec: o.fo });
        if (!r.ok) throw new Error(r.error);
      }
      out[key] = d.id;
    }
    return out;
  });
  const P = projectId;
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const post = async (channel: string, payload: unknown) => {
    const t = performance.now();
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    return { ms: performance.now() - t, status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: each reply is narrowed by the check that reads it
  };
  const HOUR_AGO = () => new Date(Date.now() - 3_600_000).toISOString();
  /** Make a copy an hour old, as if its last refresh were then (metadata only). */
  const stale = (id: string, at = HOUR_AGO()) => inOrg(() => record.serialized(record.datasetFilePath(P, id), (raw) => { raw.lastRefreshedAt = at; }));
  const meta = (id: string) => inOrg(() => datasets.getDatasetMeta(P, id));
  const byRegion = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };
  const sumOf = (r: { data?: { labels: string[]; series: { values: (number | null)[] }[] } }) => Object.fromEntries((r.data?.labels ?? []).map((l, i) => [l, r.data!.series[0].values[i]]));
  const viz = (id: string, extra: object = {}) => post('visual:data', { projectId: P, datasetId: id, encoding: byRegion, filters: [], ...extra });
  const tilesOf = (id: string) => [
    { kind: 'visual', datasetId: id, encoding: byRegion },
    { kind: 'visual', datasetId: id, encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'count' }] } },
    { kind: 'visual', datasetId: id, encoding: { category: 'region', values: [{ column: 'id', aggregation: 'max' }] } },
    { kind: 'metric', datasetId: id, column: 'amount', aggregation: 'sum' },
    { kind: 'metric', datasetId: id, column: 'amount', aggregation: 'count' },
    { kind: 'stats', spec: { kind: 'distribution', datasetId: id, columns: ['amount'] } },
  ];
  process.env.FRESH_ON_ASK_WAIT_MS = '4000';

  // ── 1. Dedupe and the wait ────────────────────────────────────────────────
  const orders = table('orders', { delayMs: 150 });
  const plain = table('plain');
  await stale(ids.orders);
  await stale(ids.plain);
  const before = (await meta(ids.orders))!;
  const load = await post('analysis:tiles', { projectId: P, items: [...tilesOf(ids.orders), { kind: 'visual', datasetId: ids.plain, encoding: byRegion }] });
  const replies = load.value as any[]; // any: per-tile replies of three channels
  ok('one dashboard load of 6 tiles on a stale copy → ONE incremental pull', orders.calls === 1, `${orders.calls} pulls`);
  ok('…and none of the control dataset without fresh on ask, however stale', plain.calls === 0);
  ok('…the pull landed inside the wait: every tile shows the new rows', replies[0]?.ok && JSON.stringify(sumOf(replies[0])) === '{"North":40,"South":25,"East":7}'
    && replies[3]?.value === 72 && replies[4]?.value === 5 && replies[5]?.ok === true, JSON.stringify(replies.slice(0, 5)).slice(0, 400));
  ok('…and no tile says "refreshing"; each is dated after the ask', replies.slice(0, 6).every((r) => r?.asOf && !r.asOf.refreshing && Date.parse(r.asOf.at) > Date.parse(before.lastRefreshedAt!)),
    JSON.stringify(replies.map((r) => r?.asOf)));
  const after = (await meta(ids.orders))!;
  ok('the run was INCREMENTAL (2 inserted), and no full re-fetch ran', after.incremental?.log[0]?.mode === 'incremental' && after.incremental.log[0].inserted === 2 && fullRefreshes === 0,
    JSON.stringify(after.incremental?.log[0]));
  ok('the record stamps the pull\'s start (freshOnAsk.triggeredAt)', !!after.freshOnAsk?.triggeredAt && Date.parse(after.freshOnAsk.triggeredAt) >= Date.parse(HOUR_AGO()));
  ok('one push for it, rows 3 → 5', (await pushed(ids.orders, 1)) && pushesFor(ids.orders).length === 1 && pushesFor(ids.orders)[0].payload.rowsAfter === 5);
  const job = jobs.snapshot().recent.find((j) => j.datasetId === ids.orders);
  ok('the refresh job ran as the system — in nobody\'s Jobs list, for no tab', job?.owner === 'acme\njobs@system' && job.client === undefined && job.state === 'done', JSON.stringify(job));
  ok('…detached from the request: no request signal reached the fetch', orders.seen[0]?.email === 'jobs@system' && orders.seen[0].signal === false, JSON.stringify(orders.seen));
  console.log(`     a stale load of 7 tiles that waited for a 150 ms pull: ${load.ms.toFixed(0)} ms`);
  const again = await post('analysis:tiles', { projectId: P, items: tilesOf(ids.orders) });
  ok('a second load at once: fresh, so no pull', orders.calls === 1 && (again.value as any[])[3]?.value === 72);
  console.log(`     the same load, fresh (one metadata read per dataset): ${again.ms.toFixed(0)} ms`);
  const card = await post('answer:card', { projectId: P, spec: { datasetId: ids.orders, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Amount by region' } });
  ok('an answer card reads the same fresh copy (East is there), undated by no refresh', card.value?.ok === true && card.value.data.labels.includes('East') && !card.value.asOf?.refreshing, card.body.slice(0, 300));

  const twice = table('twice', { delayMs: 300 });
  await stale(ids.twice);
  const [l1, l2] = await Promise.all([
    post('analysis:tiles', { projectId: P, items: tilesOf(ids.twice) }),
    post('analysis:tiles', { projectId: P, items: tilesOf(ids.twice) }),
  ]);
  ok('two loads of the same stale dataset at the same instant → still ONE pull, both fresh', twice.calls === 1 && (l1.value as any[])[3]?.value === 72 && (l2.value as any[])[3]?.value === 72, `${twice.calls} pulls`);

  // ── 2. Slow: the pull outlasts the wait ────────────────────────────────────
  process.env.FRESH_ON_ASK_WAIT_MS = '250';
  const slow = table('slow', { delayMs: 1500 });
  const oldAt = HOUR_AGO();
  await stale(ids.slow, oldAt);
  const s1 = await viz(ids.slow);
  ok('slow: the reply comes after the wait, not after the pull', s1.ms < 1200, `${s1.ms.toFixed(0)} ms`);
  ok('slow: …with the copy\'s numbers and "refreshing", dated with the copy\'s time',
    JSON.stringify(sumOf(s1.value)) === '{"North":40,"South":20}' && s1.value.asOf?.refreshing === true && s1.value.asOf.at === new Date(oldAt).toISOString(), s1.body.slice(0, 300));
  const midAsOf = await inOrg(() => figure.figureAsOf(P, [ids.slow]));
  ok('slow: a figure stamped by a request that never checked it still says refreshing (this pod\'s pull is in flight)', midAsOf?.refreshing === true);
  const s2 = await post('dashboard:metric', { projectId: P, datasetId: ids.slow, column: 'amount', aggregation: 'sum' });
  ok('slow: a KPI asked meanwhile joins the pull — no second one — and says refreshing too', slow.calls === 1 && s2.value?.value === 60 && s2.value.asOf?.refreshing === true, s2.body);
  ok('slow: the push arrives when the rows land', await pushed(ids.slow, 1));
  const s3 = await viz(ids.slow);
  ok('slow: the next ask (as the push makes a tab re-ask) shows the new rows, not refreshing', JSON.stringify(sumOf(s3.value)) === '{"North":40,"South":25,"East":7}' && !s3.value.asOf?.refreshing && slow.calls === 1, s3.body.slice(0, 300));

  // ── 3. One pull per window ─────────────────────────────────────────────────
  process.env.FRESH_ON_ASK_WAIT_MS = '2000';
  const flaky = table('flaky', { fail: 'connection refused' });
  await stale(ids.flaky);
  const f1 = await viz(ids.flaky);
  ok('window: a failing source is pulled once, and the copy answers (not refreshing: nothing runs)', flaky.calls === 1 && f1.value?.ok === true && !f1.value.asOf?.refreshing, `${flaky.calls} pulls ${JSON.stringify(f1.value?.asOf)}`);
  ok('window: …a real failure is marked as one', (await meta(ids.flaky))?.lastRefreshStatus === 'error');
  for (let i = 0; i < 3; i++) await viz(ids.flaky);
  ok('window: three more asks inside the window pull nothing (held)', flaky.calls === 1, `${flaky.calls} pulls`);
  const realNow = Date.now;
  Date.now = () => realNow() + 301_000; // the 300 s window has passed
  try {
    await viz(ids.flaky);
  } finally {
    Date.now = realNow;
  }
  ok('window: once it has passed, the next ask pulls again — once', flaky.calls === 2, `${flaky.calls} pulls`);

  // ── 4. Never a full refresh ────────────────────────────────────────────────
  process.env.FRESH_ON_ASK_WAIT_MS = '3000';
  const firstrun = table('firstrun');
  await stale(ids.firstrun);
  const jobsBefore = jobs.snapshot().recent.length;
  const fr = await viz(ids.firstrun);
  ok('never full: a dataset whose next run must be full (no mark yet) is NOT pulled', firstrun.calls === 0 && fullRefreshes === 0 && fr.value?.ok === true && !fr.value.asOf?.refreshing);
  ok('never full: …and no refresh job was queued for it', jobs.snapshot().recent.length === jobsBefore && !jobs.snapshot().active.some((j) => j.datasetId === ids.firstrun));
  const changed = table('changed', { header: [...HEADER, 'note'], body: NEW.map((r) => [...r, 'x']) });
  await stale(ids.changed);
  const chBefore = (await meta(ids.changed))!;
  const ch = await viz(ids.changed);
  const chAfter = (await meta(ids.changed))!;
  ok('never full: columns changed under an incremental pull → the fetch happened, NO full re-fetch followed', changed.calls === 1 && fullRefreshes === 0, `${changed.calls} fetches, ${fullRefreshes} full`);
  ok('never full: …nothing written, no error mark, the clock unmoved (skipped, not failed)',
    chAfter.lastRefreshStatus === 'ok' && chAfter.lastRefreshedAt === chBefore.lastRefreshedAt && chAfter.updatedAt === chBefore.updatedAt
      && chAfter.incremental?.log.length === chBefore.incremental?.log.length && chAfter.rowCount === 3, JSON.stringify({ chAfter: chAfter.lastRefreshStatus, err: chAfter.lastRefreshError }));
  const chJob = jobs.snapshot().recent.find((j) => j.datasetId === ids.changed);
  ok('never full: …its job ended done, saying why, not as an error', chJob?.state === 'done' && /next refresh must be a full one/.test(chJob.result?.message ?? '') && !/so this run was a full refresh/.test(chJob.result?.message ?? ''), JSON.stringify(chJob));
  ok('never full: …and the answer is the copy, not refreshing', JSON.stringify(sumOf(ch.value)) === '{"North":40,"South":20}' && !ch.value.asOf?.refreshing);
  const direct = await inOrg(async () => [
    await refresh.refreshDataset(P, ids.firstrun, undefined, 'incremental'),
    await refresh.refreshDataset(P, ids.noinc, undefined, 'incremental'),
  ]);
  ok('never full: the incremental-only refresh skips a first run and a dataset without incremental refresh', direct.every((r) => !r.ok && r.skipped === true) && fullRefreshes === 0,
    JSON.stringify(direct));
  const control = await inOrg(() => refresh.refreshDataset(P, ids.changed));
  ok('NEGATIVE CONTROL: the same refresh in the ordinary mode does go full (the spy sees it)', fullRefreshes === 1 && !control.ok && control.error === 'the full re-fetch spy', JSON.stringify(control));

  // ── 5. An as-of read never pulls ───────────────────────────────────────────
  const callsNow = orders.calls;
  await stale(ids.orders);
  await viz(ids.orders, { asOf: new Date().toISOString() });
  ok('as of: a stale copy viewed as of a time is not pulled', orders.calls === callsNow);

  // ── 6. Detached; abort; the event loop ─────────────────────────────────────
  process.env.FRESH_ON_ASK_WAIT_MS = '5000';
  const away = table('away', { delayMs: 1200 });
  await stale(ids.away);
  const ac = new AbortController();
  const t0 = performance.now();
  const asked = inOrg(() => fxQuery.fxScope('EUR', () => fresh.ensureFresh(P, [ids.away])), ac.signal);
  setTimeout(() => ac.abort(), 100);
  const res = await asked;
  const tookMs = performance.now() - t0;
  ok('abort: the asker going away ends the wait at once', tookMs < 600 && res.refreshing.has(ids.away), `${tookMs.toFixed(0)} ms`);
  ok('abort: …but not the pull, which lands and is announced', await pushed(ids.away, 1) && (await meta(ids.away))?.rowCount === 5);
  ok('detached: the pull ran as the system, without the asker\'s signal, as-of scope or display currency (EUR)',
    away.seen[0]?.email === 'jobs@system' && !away.seen[0].signal && away.seen[0].asOf === undefined && away.seen[0].fx !== 'EUR', JSON.stringify(away.seen));
  table('loop', { delayMs: 1500 });
  process.env.FRESH_ON_ASK_WAIT_MS = '1000';
  await stale(ids.loop);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 10);
  const waited = await inOrg(() => fresh.ensureFresh(P, [ids.loop]));
  clearInterval(timer);
  ok('the event loop: a 10 ms timer ticked through a 1 s wait (never blocked)', ticks >= 50 && waited.refreshing.has(ids.loop), `${ticks} ticks`);
  table('seqa', { delayMs: 1500 });
  table('seqb', { delayMs: 1500 });
  process.env.FRESH_ON_ASK_WAIT_MS = '600';
  await stale(ids.seqa);
  await stale(ids.seqb);
  const tSeq = performance.now();
  const seqOut = await inOrg(async () => [await fresh.ensureFresh(P, [ids.seqa]), await fresh.ensureFresh(P, [ids.seqb])]);
  const seqMs = performance.now() - tSeq;
  ok('one request asking two stale datasets one after the other waits the budget ONCE, not once each',
    seqMs < 1000 && seqOut[0].refreshing.has(ids.seqa) && seqOut[1].refreshing.has(ids.seqb), `${seqMs.toFixed(0)} ms`);
  ok('outside a request (server mode) and for a bad id, ensureFresh answers at once with nothing',
    (await fresh.ensureFresh(P, [ids.loop])).refreshing.size === 0 && (await inOrg(() => fresh.ensureFresh(P, ['../x']))).refreshing.size === 0);
  await pushed(ids.loop, 1);
  await pushed(ids.seqa, 1);
  await pushed(ids.seqb, 1);

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
