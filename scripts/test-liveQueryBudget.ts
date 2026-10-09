// What a Live question may cost, and how it stops (docs/live-data/00-plan.md
// L2.3, D9, R-L2) — the executor in server mode against the fake warehouse.
//
//   abort        a hang-up reaches the connector: runBound's signal fires, the
//                reply is `live_cancelled`, the trace counts it — and a call
//                SHARED with another asker survives one hang-up, stopping only
//                when every asker has gone
//   timeout      LIVE_QUERY_TIMEOUT_MS is the connector's own timeout and its
//                signal; past it a typed `live_timeout` (or the stale answer)
//   concurrency  LIVE_MAX_CONCURRENT per org: the N+1th waits for a slot (never
//                more than N in the warehouse), another org does not, and a
//                waiter that hangs up leaves the queue without a call
//   daily seam   L2.7's limit, stood in for: no call; stale or a typed refusal
//   context      every call carries costTag 'live', LIVE_MAX_BYTES_BILLED and
//                the live row cap; a host field goes through the SSRF guard
//                and is pinned — NEGATIVE CONTROL: the metadata address is
//                refused before runBound
//   registry     the fake resolves by id but no catalog lists it; no shipped
//                connector declares the bench dialect; prod refuses both the
//                registration and ORDINATE_TEST_LIVE_FAKE
//
//   npm run build:ts && node scripts/test-liveQueryBudget.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './liveQueryHarness';

const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const liveRun: typeof import('../src/connectors/liveRun') = require('../src/connectors/liveRun');

const { lq, fake, queryCache, budget, ORG_A, ORG_B } = H;
const show = (v: unknown): string => JSON.stringify(v);
const CANCELLED = { ok: false as const, error: 'Cancelled' };
const kpi = (column: string, aggregation: 'sum' | 'avg' | 'min' | 'max' | 'count' = 'sum') => ({ column, aggregation });
const F = (column: string, op: string, value: unknown) => ({ type: 'filter' as const, column, op, value }) as import('../src/data/transforms').FilterStep;

async function abort(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  queryCache.clear();
  H.fakeMod.resetFake();
  fake.hook = async (call) => { await H.fakeMod.whenAborted(call.signal); return CANCELLED; };
  const ac = new AbortController();
  const before = H.liveCounts();
  const asked = H.as(ORG_A, () => lq.liveMetric(P, s.liveId, kpi('amt'), []), ac.signal);
  await H.until(() => fake.calls.length === 1);
  ac.abort();
  const r = await asked;
  await H.until(() => fake.calls[0].abortedAtEnd);
  ok('abort: the reply is typed `live_cancelled`', !r.ok && r.code === 'live_cancelled' && r.error === H.msg.liveCancelled(), show(r));
  ok('abort: the connector\'s runBound saw its signal fire (it cancels the warehouse statement)', fake.calls[0].abortedAtEnd === true);
  ok('abort: the trace records it as cancelled, not failed', H.liveCounts().cancelled - before.cancelled === 1 && H.liveCounts().failed === before.failed);
  ok('abort: no flight and no slot left behind', await H.until(() => lq.flightsInAir() === 0 && budget.stats('acme').running === 0));

  // One shared call, two askers: the first hangs up, the second still gets its figure.
  H.fakeMod.resetFake();
  const go = H.gate();
  fake.hook = async (call) => { await Promise.race([go.wait(), H.fakeMod.whenAborted(call.signal)]); return undefined; };
  const a1 = new AbortController();
  const a2 = new AbortController();
  const first = H.as(ORG_A, () => lq.liveMetric(P, s.liveId, kpi('qty'), []), a1.signal);
  const second = H.as(ORG_A, () => lq.liveMetric(P, s.liveId, kpi('qty'), []), a2.signal);
  // Both must have JOINED the one call before one hangs up: under load the second can still be on its
  // way (record, cache) when the call starts, and the first would then be its only asker.
  await H.until(() => fake.calls.length === 1 && lq.askersInAir()[0] === 2);
  a1.abort();
  const r1 = await first;
  ok('shared: the asker who hung up stops waiting at once', !r1.ok && r1.code === 'live_cancelled');
  ok('shared: …but the shared warehouse call is NOT cancelled while another asker waits', fake.calls[0].signal?.aborted === false);
  go.open();
  const r2 = await second;
  ok('shared: the remaining asker gets the figure from that one call', r2.ok && typeof r2.value === 'number' && fake.calls.length === 1, show(r2));

  // Both hang up → the shared call is cancelled.
  queryCache.clear();
  H.fakeMod.resetFake();
  fake.hook = async (call) => { await H.fakeMod.whenAborted(call.signal); return CANCELLED; };
  const b1 = new AbortController();
  const b2 = new AbortController();
  const both = [b1, b2].map((c) => H.as(ORG_A, () => lq.liveMetric(P, s.liveId, kpi('amt', 'max'), []), c.signal));
  await H.until(() => fake.calls.length === 1 && lq.askersInAir()[0] === 2);
  b1.abort();
  await new Promise((r) => setTimeout(r, 20));
  ok('shared: one of two hung up — still running', fake.calls[0].signal?.aborted === false);
  b2.abort();
  const rs = await Promise.all(both);
  ok('shared: the last one hung up — the warehouse call is cancelled', await H.until(() => fake.calls[0].abortedAtEnd) && rs.every((x) => !x.ok && x.code === 'live_cancelled'));
}

async function timeout(s: H.OrgSetup): Promise<void> {
  const P = s.projectId;
  queryCache.clear();
  H.fakeMod.resetFake();
  process.env.LIVE_QUERY_TIMEOUT_MS = '150';
  fake.hook = async (call) => { await H.fakeMod.whenAborted(call.signal); return CANCELLED; };
  const t = performance.now();
  const r = await lq.liveMetric(P, s.liveId, kpi('amt', 'min'), []);
  const ms = performance.now() - t;
  ok('timeout: a typed `live_timeout` in the catalog\'s sentence', !r.ok && r.code === 'live_timeout' && r.error === H.msg.liveWarehouseTimeout('0.15'), show(r));
  ok('timeout: the connector was given LIVE_QUERY_TIMEOUT_MS and its signal fired', fake.calls[0].timeoutMs === 150 && await H.until(() => fake.calls[0].abortedAtEnd));
  ok(`timeout: answered after ~150 ms (${ms.toFixed(0)} ms)`, ms >= 140 && ms < 2000);
  // With an earlier answer cached, a timeout serves it, stale.
  fake.hook = null;
  process.env.LIVE_QUERY_TIMEOUT_MS = '60000';
  const good = await lq.liveMetric(P, s.liveId, kpi('amt', 'max'), []);
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, s.liveId, 0));
  process.env.LIVE_QUERY_TIMEOUT_MS = '150';
  fake.hook = async (call) => { await H.fakeMod.whenAborted(call.signal); return CANCELLED; };
  const stale = await lq.liveMetric(P, s.liveId, kpi('amt', 'max'), []);
  ok('timeout: with an answer cached, the stale answer instead', stale.ok && good.ok && stale.value === good.value && stale.asOf.stale === true);
  fake.hook = null;
  delete process.env.LIVE_QUERY_TIMEOUT_MS;
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, s.liveId, 300));
}

async function concurrency(a: H.OrgSetup, b: H.OrgSetup): Promise<void> {
  queryCache.clear();
  H.fakeMod.resetFake();
  process.env.LIVE_MAX_CONCURRENT = '2';
  let inFlight = 0;
  let peak = 0;
  const go = H.gate();
  fake.hook = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await go.wait();
    inFlight -= 1;
    return undefined;
  };
  const three = [1, 2, 3].map((n) => H.as(ORG_A, () => lq.liveMetric(a.projectId, a.liveId, kpi('amt'), [F('qty', '>=', n)])));
  await H.until(() => fake.calls.length === 2 && budget.stats('acme').waiting === 1);
  await new Promise((r) => setTimeout(r, 30));
  ok('cap: with LIVE_MAX_CONCURRENT=2, two questions reach the warehouse and the third WAITS', fake.calls.length === 2 && budget.stats('acme').waiting === 1, show(budget.stats('acme')));
  const other = H.as(ORG_B, () => lq.liveMetric(b.projectId, b.liveId, kpi('amt'), []));
  ok('cap: per org — another org\'s question is not queued behind it', await H.until(() => fake.calls.length === 3) && budget.stats('globex').waiting === 0);
  const quit = new AbortController();
  const quitter = H.as(ORG_A, () => lq.liveMetric(a.projectId, a.liveId, kpi('amt'), [F('qty', '>=', 9)]), quit.signal);
  await H.until(() => budget.stats('acme').waiting === 2);
  quit.abort();
  const q = await quitter;
  ok('cap: a waiter that hangs up leaves the queue and never reaches the warehouse', !q.ok && q.code === 'live_cancelled' && budget.stats('acme').waiting === 1 && fake.calls.length === 3);
  go.open();
  const rs = await Promise.all([...three, other]);
  ok('cap: once a slot frees, the waiting question runs; all answer', rs.every((r) => r.ok) && fake.calls.length === 4);
  ok(`cap: never more than 2 of org A's statements in the warehouse at once (+1 of org B's): peak ${peak}`, peak === 3);
  ok('cap: every slot released', budget.stats('acme').running === 0 && budget.stats('globex').running === 0);
  fake.hook = null;
  delete process.env.LIVE_MAX_CONCURRENT;
}

async function daily(s: H.OrgSetup): Promise<void> {
  queryCache.clear();
  H.fakeMod.resetFake();
  const good = await lq.liveMetric(s.projectId, s.liveId, kpi('qty', 'avg'), []);
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(s.projectId, s.liveId, 0));
  budget.setDailyCheckForTest(() => ({ ok: false, message: 'Today\'s live queries are used up (test).' }));
  const stale = await lq.liveMetric(s.projectId, s.liveId, kpi('qty', 'avg'), []);
  const none = await lq.liveMetric(s.projectId, s.liveId, kpi('qty', 'max'), []);
  budget.setDailyCheckForTest(null);
  ok('daily seam: past the limit a cached answer is served stale, with no warehouse call', stale.ok && good.ok && stale.value === good.value && stale.asOf.stale === true && fake.calls.length === 1);
  ok('daily seam: with nothing cached, a typed refusal carrying the limit\'s sentence', !none.ok && none.code === 'live_refused' && none.reason === 'dailyLimit'
    && none.error === 'Today\'s live queries are used up (test).' && fake.calls.length === 1, show(none));
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(s.projectId, s.liveId, 300));
}

async function connectorContext(s: H.OrgSetup): Promise<void> {
  queryCache.clear();
  H.fakeMod.resetFake();
  await lq.liveMetric(s.projectId, s.liveId, kpi('amt', 'count'), []);
  const c = fake.calls[0];
  ok('context: costTag live, LIVE_MAX_BYTES_BILLED, LIVE_QUERY_TIMEOUT_MS\'s default, the live row cap',
    c.costTag === 'live' && c.maxBytes === envMod.DEFAULT_MAX_BYTES_BILLED && c.timeoutMs === envMod.DEFAULT_LIVE_QUERY_TIMEOUT_MS
      && c.rowLimit === liveRun.LIVE_ROW_LIMIT && c.signal instanceof AbortSignal, show({ ...c, signal: undefined, sql: undefined }));
  ok('context: values travel as parameters', c.params.length === 0 || c.params.every((p) => !c.sql.includes(String(p.value))));

  // A host field goes through the SSRF guard: the metadata address is refused BEFORE runBound.
  const net = (host: string) => H.as(ORG_A, () => H.liveOver(s.projectId, { table: 'live_typed' }, H.fx.COLUMNS, H.fakeMod.LIVE_FAKE_NET_ID, { host }));
  const meta = await net('169.254.169.254');
  H.fakeMod.resetFake();
  const refused = await H.capturingWarn(() => lq.liveMetric(s.projectId, meta.liveId, kpi('amt'), []));
  ok('SSRF: a connection aimed at the cloud metadata address never reaches runBound', !refused.value.ok && fake.calls.length === 0
    && refused.lines.some((l) => /link-local/.test(l)), show(refused));
  const pub = await net('8.8.8.8');
  const passed = await lq.liveMetric(s.projectId, pub.liveId, kpi('amt'), []);
  ok('SSRF NEGATIVE CONTROL: a public address passes, and runBound gets it PINNED', passed.ok && fake.calls.length === 1 && fake.calls[0].pinned === '8.8.8.8', show(fake.calls[0]?.pinned));

  // A result past the live row cap is refused, never drawn in part.
  H.fakeMod.resetFake();
  fake.hook = async () => ({ ok: true, columns: [], rows: [], truncated: true });
  const big = await lq.liveVizData(s.projectId, s.liveId, { category: 'many', values: [{ column: 'amt', aggregation: 'sum' }] }, [F('qty', '!=', 77)]);
  fake.hook = null;
  ok('row cap: a truncated result is a typed refusal (tooManyGroups), not part of a chart', !big.ok && big.code === 'live_refused' && big.reason === 'tooManyGroups'
    && big.error === H.msg.liveTooManyGroups(liveRun.LIVE_ROW_LIMIT.toLocaleString('en-US')), show(big));
}

function registryAndEnv(): void {
  ok('registry: the fake resolves by id', registry.getConnector(H.fakeMod.LIVE_FAKE_ID)?.live?.dialect === 'duckdb' && registry.isKnownConnectorId(H.fakeMod.LIVE_FAKE_NET_ID));
  ok('registry: …but no catalog lists it (the picker never offers it)', !registry.listConnectors().some((d) => d.family === 'live-fake')
    && !registry.connectorCatalog().some((e) => e.id === H.fakeMod.LIVE_FAKE_ID || e.id === H.fakeMod.LIVE_FAKE_NET_ID));
  ok('registry: no shipped connector declares the bench dialect', registry.listConnectors().every((d) => d.live?.dialect !== 'duckdb'));
  const twin = { ...registry.getConnector(H.fakeMod.LIVE_FAKE_ID)!, id: 'live-fake-twin' };
  const prev = process.env.ORDINATE_ENV;
  process.env.ORDINATE_ENV = 'prod';
  let prodThrew = false;
  try { registry.registerTestConnector(twin); } catch { prodThrew = true; }
  process.env.ORDINATE_ENV = prev ?? '';
  if (prev === undefined) delete process.env.ORDINATE_ENV;
  let realThrew = false;
  try { registry.registerTestConnector({ ...twin, id: 'snowflake' }); } catch { realThrew = true; }
  registry.registerTestConnector(twin);
  ok('registry: ORDINATE_ENV=prod refuses a test connector; a real id is refused too', prodThrew && realThrew && registry.getConnector('live-fake-twin') !== null);

  const base = { AUTH_MODE: 'dev', DATA_DIR: H.DATA };
  const refuses = (src: Record<string, string>, re: RegExp): boolean => {
    try { envMod.parseEnv({ ...base, ...src }); return false; } catch (e) { return e instanceof envMod.EnvError && re.test(e.message); }
  };
  ok('env: ORDINATE_TEST_LIVE_FAKE=1 is refused in prod', refuses({ ORDINATE_ENV: 'prod', ORDINATE_TEST_LIVE_FAKE: '1' }, /ORDINATE_TEST_LIVE_FAKE/));
  ok('env NEGATIVE CONTROL: the same prod env without it parses; dev with it says so',
    envMod.parseEnv({ ...base, ORDINATE_ENV: 'prod' }).testLiveFake === false && envMod.parseEnv({ ...base, ORDINATE_TEST_LIVE_FAKE: '1' }).testLiveFake === true);
  ok('env: LIVE_QUERY_TIMEOUT_MS and LIVE_MAX_CONCURRENT are validated at startup',
    refuses({ LIVE_QUERY_TIMEOUT_MS: '50' }, /LIVE_QUERY_TIMEOUT_MS/) && refuses({ LIVE_QUERY_TIMEOUT_MS: '1m' }, /LIVE_QUERY_TIMEOUT_MS/)
      && refuses({ LIVE_MAX_CONCURRENT: '0' }, /LIVE_MAX_CONCURRENT/) && refuses({ LIVE_MAX_CONCURRENT: '1001' }, /LIVE_MAX_CONCURRENT/)
      && refuses({ ORDINATE_TEST_LIVE_FAKE: 'yes' }, /ORDINATE_TEST_LIVE_FAKE/));
  ok('env: their defaults are 60000 ms and 4', envMod.liveQueryTimeoutMs(undefined) === 60_000 && envMod.liveMaxConcurrent('') === 4
    && envMod.liveQueryTimeoutMs('100') === 100 && envMod.liveMaxConcurrent('1000') === 1000);
}

// AbortSignal.timeout's timer is unref'd (right for a server, whose sockets keep
// it alive); a suite with nothing else pending would exit before it fires.
const keepAlive = setInterval(() => undefined, 1000);

async function main(): Promise<void> {
  H.trace.reset();
  const a = await H.setupOrg(ORG_A);
  const b = await H.setupOrg(ORG_B);
  await H.as(ORG_A, () => abort(a));
  await H.as(ORG_A, () => timeout(a));
  await concurrency(a, b);
  await H.as(ORG_A, () => daily(a));
  await H.as(ORG_A, () => connectorContext(a));
  registryAndEnv();
}

main()
  .catch((e) => ok('live budget suite threw', false, e && (e as Error).stack))
  .finally(() => {
    clearInterval(keepAlive);
    H.cleanup();
    finish();
  });
