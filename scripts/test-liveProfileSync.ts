// When and how a Live dataset's schema sync runs, and what stops it
// (docs/live-data/00-plan.md L2.5, D9) — on the fake warehouse in server mode.
//
//   schedule   the pure due rule (24 h, stalest first, retried hourly); the
//              scheduler's tick queues ONE sync job per due dataset, skips a
//              fresh one, never queues a second while one runs, and stamps the
//              attempt so a failing warehouse is not asked every minute
//   doors      on create (connection:import → Live) the profile lands without
//              the create waiting; on demand over the RPC route (`write`), an
//              extract refused; two starts at once → one job
//   cost       a priced warehouse (BigQuery's dry run) over LIVE_MAX_BYTES_BILLED
//              or the connection's own ceiling → the sample is skipped, typed,
//              nothing runs — NEGATIVE CONTROL: under it, one statement runs;
//              ONE second try, LIMIT only, when a BLOCK sample comes back
//              empty or the engine refuses its sample clause (NEGATIVE
//              CONTROLS: no percent, no clause or a timeout — no second try)
//   budget     the daily limit refuses the sample, typed (`dailyLimit`), the last
//              figures kept; the concurrency slot is the questions' own
//   failures   a warehouse error → a catalog sentence, no SQL, table or secret
//              in the reply or the log (R-L6 canary); a failed describe changes
//              nothing; a timeout and a cancel are typed, a cancel writes nothing
//   cache      a sync moves `schemaSyncedAt`, so a cached figure is asked again
//
//   npm run build:ts && node scripts/test-liveProfileSync.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import * as H from './liveQueryHarness';

const job: typeof import('../src/engine/live/schemaSyncJob') = require('../src/engine/live/schemaSyncJob');
const sync: typeof import('../src/engine/live/schemaSync') = require('../src/engine/live/schemaSync');
const profileSql: typeof import('../src/engine/live/profileSql') = require('../src/engine/live/profileSql');
const scheduler: typeof import('../src/app/refreshScheduler') = require('../src/app/refreshScheduler');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const liveIpc: typeof import('../src/ipc/liveDatasets') = require('../src/ipc/liveDatasets');
const pmsg: typeof import('../src/engine/liveProfileMessages') = require('../src/engine/liveProfileMessages');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

const { fake, fx, ORG_A, budget, lq, queryCache } = H;
const show = (v: unknown): string => JSON.stringify(v);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();
const meta = (P: string, D: string) => H.as(ORG_A, () => H.datasets.getDatasetMeta(P, D));
const syncJobs = (): import('../src/app/jobs').Job[] => jobs.snapshot().active.filter((j) => j.label.startsWith('Sync schema'));
/** Set a Live record's sync stamps by hand (another day's state). */
const stamp = (P: string, D: string, synced: string, attempt?: string) => H.as(ORG_A, () => record.serialized(record.datasetFilePath(P, D), (raw) => {
  const live = raw.live as Record<string, unknown>;
  live.schemaSyncedAt = synced;
  if (attempt) live.syncAttemptAt = attempt;
  else delete live.syncAttemptAt;
}));
const PROFILE_MARK = 'CROSS JOIN lv_ix'; // what only the profile statement says
const profileCalls = (): number => fake.calls.filter((c) => c.sql.includes(PROFILE_MARK)).length;
/** Poll an async condition until it holds, or `ms` passes. */
async function eventually(cond: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}
type Post = (channel: string, payload: unknown) => Promise<{ status: number; body: string; value: Record<string, unknown> | null }>;

function dueRule(): void {
  const now = Date.UTC(2026, 9, 9, 12);
  const m = (id: string, synced?: string, attempt?: string) => ({ projectId: 'p', id, name: id, schemaSyncedAt: synced, schemaSyncAttemptAt: attempt });
  const list = [
    m('fresh', iso(now - HOUR)),
    m('day', iso(now - DAY)),
    m('older', iso(now - 3 * DAY)),
    m('never'),
    m('garbled', 'not a time'),
    m('tried', iso(now - 2 * DAY), iso(now - 10 * 60 * 1000)),
    m('triedLongAgo', iso(now - 2 * DAY), iso(now - 2 * HOUR)),
    m('almost', iso(now - DAY + 1)),
  ];
  ok('due: 24 h or older, never or unreadable first, stalest first; fresh and just-attempted skipped',
    show(job.dueSchemaSyncs(list, now).map((x) => x.id)) === show(['never', 'garbled', 'older', 'triedLongAgo', 'day']), show(job.dueSchemaSyncs(list, now).map((x) => x.id)));
  ok('due: a 1 ms short of a day is not due; exactly a day is', !job.dueSchemaSyncs([m('a', iso(now - DAY + 1))], now).length && job.dueSchemaSyncs([m('a', iso(now - DAY))], now).length === 1);
}

async function schedule(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const fresh = await H.as(ORG_A, () => H.liveOver(P, { table: 'live_typed' }, fx.COLUMNS));
  const stale = await H.as(ORG_A, () => H.liveOver(P, { table: 'live_typed' }, fx.COLUMNS));
  const now = Date.now();
  await stamp(P, s.liveId, iso(now)); // the harness's own Live dataset: fresh too
  await stamp(P, stale.liveId, iso(now - 2 * DAY));
  H.fakeMod.resetFake();
  const gate = H.gate();
  fake.hook = async () => { await gate.wait(); return undefined; };
  await H.as(ORG_A, () => scheduler.tickNow(now));
  const first = syncJobs();
  ok('tick: ONE sync job, for the stale dataset; the fresh one is skipped', first.length === 1 && first[0].datasetId === stale.liveId && first[0].silent === true, show(first));
  await H.until(() => fake.calls.length === 1);
  await H.as(ORG_A, () => scheduler.tickNow(now + 1000));
  ok('tick: while it runs, the next tick queues nothing more (once per dataset)', syncJobs().length === 1 && fake.calls.length === 1, show(syncJobs()));
  const attempt = (await meta(P, stale.liveId))?.live?.syncAttemptAt;
  ok('tick: the attempt is stamped before the job runs', attempt === iso(now));
  gate.open();
  await H.until(() => syncJobs().length === 0, 10_000);
  const after = await meta(P, stale.liveId);
  ok('tick: the job lands — synced now, profiled', !!after?.live && Date.parse(after.live.schemaSyncedAt) >= now - 1000 && after.live.profile?.sampleRows === 1060);
  fake.hook = null;
  await H.as(ORG_A, () => scheduler.tickNow(now + 2000));
  ok('tick: …and the next tick finds nothing due', syncJobs().length === 0 && profileCalls() === 1);
  ok('tick: an extract is never synced, a Live dataset never refreshed', !jobs.snapshot().recent.some((j) => j.datasetId === s.extractId) && fresh.liveId !== '');

  // A warehouse that cannot even describe the table: nothing changes, the attempt is remembered, no retry within the hour.
  await H.warehouseExec(ORG_A, 'CREATE OR REPLACE TABLE gone_soon AS SELECT 1 AS a');
  const doomed = await H.as(ORG_A, () => H.liveOver(P, { table: 'gone_soon' }, [{ name: 'a', type: 'number' }]));
  await H.warehouseExec(ORG_A, 'DROP TABLE gone_soon');
  await stamp(P, doomed.liveId, iso(now - 2 * DAY));
  await H.as(ORG_A, () => scheduler.tickNow(now + 3000));
  await H.until(() => syncJobs().length === 0, 10_000);
  const failed = jobs.snapshot().recent.find((j) => j.datasetId === doomed.liveId);
  const d = await meta(P, doomed.liveId);
  ok('failed describe: the job errors with the catalog sentence, the record is unchanged', failed?.state === 'error' && failed.error === pmsg.liveSyncReadFailed()
    && d?.live?.schemaSyncedAt === iso(now - 2 * DAY) && d.live.syncAttemptAt === iso(now + 3000), show({ failed, live: d?.live }));
  await H.as(ORG_A, () => scheduler.tickNow(now + 3000 + 10 * 60 * 1000));
  ok('failed describe: ten minutes later the tick does not ask again (hourly retry)', syncJobs().length === 0 && jobs.snapshot().recent.filter((j) => j.datasetId === doomed.liveId).length === 1);
}

async function doors(s: H.OrgSetup, post: Post): Promise<void> {
  const P = s.projectId;
  H.fakeMod.resetFake();
  const created = await H.as(ORG_A, () => liveIpc.createLiveDataset({ projectId: P, connId: s.connId, table: 'live_typed', name: 'Made live' }));
  const id = (created as { dataset?: { id: string } }).dataset?.id ?? '';
  ok('create: answers at once, before the sample', created.ok === true && !!id && !(await meta(P, id))?.live?.profile);
  await eventually(async () => !!(await meta(P, id))?.live?.profile && job.syncsStarting() === 0);
  const m = await meta(P, id);
  ok('create: the first sync and profile land as a job', m?.live?.profile?.sampleRows === 1060 && m.live.profile.columns.length === fx.COLUMNS.length
    && jobs.snapshot().recent.some((j) => j.datasetId === id && j.label === 'Sync schema · Made live' && j.state === 'done'), show(m?.live).slice(0, 200));

  const gate = H.gate();
  fake.hook = async () => { await gate.wait(); return undefined; };
  const [a, b] = await H.as(ORG_A, () => Promise.all([job.startSchemaSync(P, id), job.startSchemaSync(P, id)]));
  ok('two starts at once: one job, the other "already running"', [a?.status, b?.status].sort().join() === 'already_running,queued');
  const third = await H.as(ORG_A, () => job.startSchemaSync(P, id));
  ok('…and a third while it runs', third?.status === 'already_running' && syncJobs().length === 1);
  gate.open();
  if (a?.status === 'queued') await a.done;
  if (b?.status === 'queued') await b.done;
  fake.hook = null;
  ok('…no start is left behind on this pod', job.syncsStarting() === 0);

  const r = await post('dataset:syncLiveSchema', { projectId: P, datasetId: id });
  ok('on demand: the route waits for the job and answers what it found', r.value?.ok === true && r.value.status === 'synced' && r.value.columns === fx.COLUMNS.length
    && (r.value.sample as { ok?: boolean })?.ok === true, r.body.slice(0, 300));
  ok('on demand: no SQL, no table name in the reply', !/live_typed|lv_ix|SELECT/i.test(r.body));
  const ex = await post('dataset:syncLiveSchema', { projectId: P, datasetId: s.extractId });
  ok('on demand: an extract is refused, typed', ex.value?.ok === false && ex.value.code === 'not_live' && ex.value.error === pmsg.liveSyncNotLive());
}

async function cost(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const priced = await H.as(ORG_A, () => H.liveOver(P, { table: 'live_typed' }, fx.COLUMNS, H.fakeMod.LIVE_FAKE_PRICED_ID));
  const D = priced.liveId;
  process.env.LIVE_MAX_BYTES_BILLED = '5000';
  H.fakeMod.resetFake();
  fake.bytes = 100;
  const under = await H.as(ORG_A, () => sync.syncLiveSchema(P, D));
  ok('estimate NEGATIVE CONTROL: under the cap, priced first, then ONE statement runs', under.ok && under.sample.ok && fake.estimates.length === 1 && profileCalls() === 1
    && fake.estimates[0].sql === fake.calls[0].sql && fake.estimates[0].maxBytes === 5000, show(under));
  H.fakeMod.resetFake();
  fake.bytes = 6000;
  const before = (await meta(P, D))?.live;
  const over = await H.as(ORG_A, () => sync.syncLiveSchema(P, D));
  const after = (await meta(P, D))?.live;
  ok('estimate: over LIVE_MAX_BYTES_BILLED the sample is skipped, typed, and nothing runs', over.ok && !over.sample.ok && over.sample.code === 'live_refused'
    && over.sample.reason === 'tooCostly' && over.sample.bytes === 6000 && over.sample.error === pmsg.liveSampleTooCostly() && fake.calls.length === 0, show(over));
  ok('estimate: the columns still sync; the last figures are kept, marked skipped', !!after && after.schemaSyncedAt !== before?.schemaSyncedAt && after.profile?.skipped === 'tooCostly'
    && after.profile.sampledAt === before?.profile?.sampledAt && after.profile.columns[2].values?.length === 4);
  const own = await H.as(ORG_A, () => H.liveOver(P, { table: 'live_typed' }, fx.COLUMNS, H.fakeMod.LIVE_FAKE_PRICED_ID, { maxBytesBilled: 50 }));
  H.fakeMod.resetFake();
  fake.bytes = 100;
  const ownOver = await H.as(ORG_A, () => sync.syncLiveSchema(P, own.liveId));
  ok('estimate: the connection\'s own lower ceiling counts too', ownOver.ok && !ownOver.sample.ok && ownOver.sample.reason === 'tooCostly' && fake.calls.length === 0, show(ownOver));
  H.fakeMod.resetFake();
  fake.bytes = { ok: false, error: `dry run failed for select * from live_typed (${H.SECRET_CANARY})` };
  const { value: broken, lines } = await H.capturingWarn(() => H.as(ORG_A, () => sync.syncLiveSchema(P, D)));
  ok('estimate: a failed dry run skips the sample (never runs blind), typed; the secret reaches no log line', broken.ok && !broken.sample.ok && broken.sample.code === 'live_failed'
    && fake.calls.length === 0 && !lines.join('\n').includes(H.SECRET_CANARY) && !show(broken).includes('live_typed'), show({ broken, lines }));
  ok('estimate: a warehouse that cannot price is never asked to (the plain fake)', fake.estimates.length === 1);
  delete process.env.LIVE_MAX_BYTES_BILLED;
}

async function secondTry(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const empty = { ok: true as const, columns: profileSql.PROFILE_OUTPUT.map((name) => ({ name, type: 'VARCHAR' })), rows: [], truncated: false };
  H.fakeMod.resetFake();
  fake.rowEstimate = 1_000_000_000; // the catalog counts a huge table: a block-sample percent is planned (BigQuery's TABLESAMPLE SYSTEM)
  let missed = false;
  fake.hook = async (call) => {
    if (missed || !call.sql.includes(PROFILE_MARK)) return undefined;
    missed = true; // the block sample picked no block
    return empty;
  };
  const r = await H.as(ORG_A, () => sync.syncLiveSchema(P, s.liveId));
  const m = (await meta(P, s.liveId))?.live?.profile;
  ok('empty block sample: asked ONCE more without the percent, and the second answer is what is stored', r.ok && r.sample.ok && r.sample.rows === 1060
    && profileCalls() === 2 && m?.sampleRows === 1060 && (m.columns[2].values?.length ?? 0) > 0, show(r));
  // NEGATIVE CONTROL: no row estimate, no percent — an empty answer is the table's own: one call, stored as an empty sample.
  H.fakeMod.resetFake();
  fake.hook = async (call) => (call.sql.includes(PROFILE_MARK) ? empty : undefined);
  const r2 = await H.as(ORG_A, () => sync.syncLiveSchema(P, s.liveId));
  fake.hook = null;
  ok('empty block sample NEGATIVE CONTROL: without a percent an empty answer is not retried', r2.ok && r2.sample.ok && r2.sample.rows === 0 && profileCalls() === 1, show(r2));

  // The engine refuses its own sample clause (BigQuery's TABLESAMPLE on a view, say): ONE more try, LIMIT only.
  H.fakeMod.resetFake();
  fake.hook = async (call) => (call.sql.includes('USING SAMPLE') ? { ok: false, error: 'sampling is not supported on views' } : undefined);
  const { value: viaLimit, lines } = await H.capturingWarn(() => H.as(ORG_A, () => sync.syncLiveSchema(P, s.liveId)));
  fake.hook = null;
  const tries = fake.calls.filter((c) => c.sql.includes(PROFILE_MARK));
  ok('refused sample clause: asked ONCE more with the LIMIT only, and stored as a "limit" sample', viaLimit.ok && viaLimit.sample.ok && viaLimit.sample.method === 'limit'
    && viaLimit.sample.rows === 1060 && tries.length === 2 && tries[0].sql.includes('USING SAMPLE') && !tries[1].sql.includes('USING SAMPLE')
    && (await meta(P, s.liveId))?.live?.profile?.method === 'limit', show(viaLimit));
  ok('refused sample clause: the first refusal is logged once, the reply carries none of it', lines.length === 1 && !show(viaLimit).includes('views'), lines.join('\n'));
  // NEGATIVE CONTROL: a LIMIT-only statement that fails (a defining query: no clause to drop) is not tried again.
  const viaQuery = await H.as(ORG_A, () => H.liveOver(P, { sql: 'SELECT * FROM live_typed' }, fx.COLUMNS));
  H.fakeMod.resetFake();
  fake.hook = async (call) => (call.sql.includes(PROFILE_MARK) ? { ok: false, error: 'boom' } : undefined);
  const once = await H.as(ORG_A, () => sync.syncLiveSchema(P, viaQuery.liveId));
  fake.hook = null;
  ok('refused sample clause NEGATIVE CONTROL: with no clause to drop, a failure is one statement, typed', once.ok && !once.sample.ok && once.sample.code === 'live_failed' && profileCalls() === 1, show(once));
  await H.as(ORG_A, () => sync.syncLiveSchema(P, s.liveId)); // back to the real figures for what follows
}

async function limits(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  const D = s.liveId;
  await H.as(ORG_A, () => sync.syncLiveSchema(P, D)); // a profile to keep
  H.fakeMod.resetFake();
  budget.setDailyCheckForTest(() => ({ ok: false, message: 'Today\'s live queries are used up (test).' }));
  const daily = await H.as(ORG_A, () => sync.syncLiveSchema(P, D));
  budget.setDailyCheckForTest(null);
  const m = (await meta(P, D))?.live;
  ok('budget: the daily limit refuses the sample, typed, in the seam\'s own sentence', daily.ok && !daily.sample.ok && daily.sample.code === 'live_refused'
    && daily.sample.reason === 'dailyLimit' && daily.sample.error === 'Today\'s live queries are used up (test).' && fake.calls.length === 0, show(daily));
  ok('budget: the last figures are kept, marked refused', m?.profile?.skipped === 'refused' && m.profile.columns[2].values?.length === 4);

  process.env.LIVE_MAX_CONCURRENT = '1';
  const held = H.gate();
  fake.hook = async (call) => { if (!call.sql.includes(PROFILE_MARK)) await held.wait(); return undefined; };
  const question = H.as(ORG_A, () => lq.liveMetric(P, D, { column: 'amt', aggregation: 'max' }, []));
  await H.until(() => fake.calls.length === 1);
  const syncing = H.as(ORG_A, () => sync.syncLiveSchema(P, D));
  await H.until(() => budget.stats(ORG_A.org.id).waiting === 1);
  ok('budget: the sample waits for a concurrency slot like any live question', budget.stats(ORG_A.org.id).waiting === 1 && fake.calls.length === 1);
  held.open();
  const [q, r] = await Promise.all([question, syncing]);
  ok('budget: …and runs when the slot frees', q.ok && r.ok && r.sample.ok && profileCalls() === 1);
  delete process.env.LIVE_MAX_CONCURRENT;

  H.fakeMod.resetFake();
  fake.hook = async () => ({ ok: false, error: `Syntax error near "lv_ix" in select * from live_typed password=${H.SECRET_CANARY}` });
  const { value: failed, lines } = await H.capturingWarn(() => H.as(ORG_A, () => sync.syncLiveSchema(P, D)));
  ok('failure: a warehouse error is a catalog sentence — no SQL, table or secret in the reply', failed.ok && !failed.sample.ok && failed.sample.code === 'live_failed'
    && failed.sample.error === pmsg.liveSampleFailed() && !/lv_ix|live_typed|password/.test(show(failed)), show(failed));
  ok('failure R-L6: the secret reaches no log line; the reason does', !lines.join('\n').includes(H.SECRET_CANARY) && lines.some((l) => l.includes('liveSync') || l.includes('live:duckdb')), lines.join('\n'));

  process.env.LIVE_QUERY_TIMEOUT_MS = '150';
  H.fakeMod.resetFake();
  fake.hook = async (call) => { await H.fakeMod.whenAborted(call.signal); return undefined; };
  const slow = await H.as(ORG_A, () => sync.syncLiveSchema(P, D));
  ok('timeout: typed live_timeout, never tried again; the columns still sync', slow.ok && !slow.sample.ok && slow.sample.code === 'live_timeout' && profileCalls() === 1, show(slow));
  delete process.env.LIVE_QUERY_TIMEOUT_MS;
  const ctl = new AbortController();
  const was = (await meta(P, D))?.live?.schemaSyncedAt;
  fake.hook = async (call) => { ctl.abort(); await H.fakeMod.whenAborted(call.signal); return undefined; };
  const cancelled = await H.as(ORG_A, () => sync.syncLiveSchema(P, D, ctl.signal));
  fake.hook = null;
  ok('cancel: typed live_cancelled, and nothing is written', !cancelled.ok && cancelled.code === 'live_cancelled' && (await meta(P, D))?.live?.schemaSyncedAt === was, show(cancelled));
}

async function cacheKey(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  queryCache.clear();
  H.fakeMod.resetFake();
  await H.as(ORG_A, () => lq.liveMetric(P, s.liveId, { column: 'amt', aggregation: 'sum' }, []));
  await H.as(ORG_A, () => lq.liveMetric(P, s.liveId, { column: 'amt', aggregation: 'sum' }, []));
  ok('cache: the second ask is a hit', fake.calls.length === 1);
  await H.as(ORG_A, () => sync.syncLiveSchema(P, s.liveId));
  await H.as(ORG_A, () => lq.liveMetric(P, s.liveId, { column: 'amt', aggregation: 'sum' }, []));
  ok('cache: after a sync the same figure is asked again (schemaSyncedAt is in the key)', fake.calls.length === 3 && profileCalls() === 1, String(fake.calls.length));
}

// AbortSignal.timeout's timer is unref'd: without this the process would exit while a held statement waits on it.
const keepAlive = setInterval(() => undefined, 1000);

(async () => {
  dueRule();
  const s = await H.setupOrg(ORG_A);
  await schedule(s);
  appMod.registerHandlers();
  // Closed only at the end: closing the app shuts the DuckDB workers, and with them the fake warehouse's tables.
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: H.DATA }), undefined, () => ORG_A);
  const post: Post = async (channel, payload) => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${channel}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    return { status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : null) as Record<string, unknown> | null };
  };
  await doors(s, post);
  await cost(s);
  await secondTry(s);
  await limits(s);
  await cacheKey(s);
  await app.close();
  H.cleanup();
  clearInterval(keepAlive);
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
