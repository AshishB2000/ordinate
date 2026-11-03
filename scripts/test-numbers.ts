// Self-check for Home's "Your numbers" (src/ipc/numbers.ts): REAL HTTP, server
// mode, the sample project, every DuckDB call in the org's locked worker:
//
//   1. THE FIGURES ARE THE CHANNELS' OWN (differential, Object.is): a metric's
//      tile is metric:series' last period, its sparkline the series, its change
//      the last two points; a metric with no date column shows metric:value; a
//      scorecard's tile is scorecard:compute's counts.
//   2. Following is the caller's own: Ann's follows never show for Bob, and
//      his never move hers. (A viewer may follow: both channels are `read`;
//      without a database this harness gives a viewer no project to read.)
//   3. Nothing followed: the project's first metrics come back as suggestions;
//      once something is followed, none.
//   4. Refusals: an unknown id, past FOLLOW_MAX; a deleted metric drops out; a
//      malformed input → 400; another org → 403.
//
//   npm run build:ts && node scripts/test-numbers.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const config: typeof import('../src/app/config') = require('../src/app/config');
const rpcMod: typeof import('../src/server/rpc') = require('../src/server/rpc');

type Identity = import('../src/server/context').Identity;
type Role = import('../src/server/context').Role;
type Reply = { status: number; body: any }; // any: each reply is narrowed by the assertion that reads it

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-numbers-')));
const who = (org: string, user: string, role: Role = 'admin'): Identity => ({ user: { email: `${user}@${org}`, role }, org: { id: org } });
let base = '';

async function rpc(org: string, user: string, channel: string, payload?: unknown, role: Role = 'admin'): Promise<Reply> {
  const res = await fetch(`${base}/api/rpc/${channel}`, {
    method: 'POST',
    headers: withCsrf({ 'content-type': 'application/json', 'x-test-org': org, 'x-test-user': user, 'x-test-role': role }),
    body: wire.encode({ args: payload === undefined ? [] : [payload] }),
  });
  const text = await res.text();
  return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
}

/** A server-only handler (no contract, so no RPC route), called in Ann's request context as the server calls it. */
function direct(channel: string, payload: unknown): Promise<any> { // any: the handler's own reply
  return context.runInContext(who('org-a', 'ann'), 'direct', async () => rpcMod.handlers.get(channel)!(undefined, payload));
}

/** An independent reading of the change: signed percent, one decimal under 10%, a real minus. */
function changeText(value: number, prev: number): string {
  const pct = ((value - prev) / Math.abs(prev)) * 100;
  const a = Math.abs(pct);
  const n = a.toLocaleString('en-US', { minimumFractionDigits: a < 10 ? 1 : 0, maximumFractionDigits: a < 10 ? 1 : 0 });
  return (pct > 0 ? '+' : pct < 0 ? '−' : '') + n + '%';
}

async function suite(): Promise<void> {
  const ann = (channel: string, payload?: unknown) => rpc('org-a', 'ann', channel, payload);
  const bob = (channel: string, payload?: unknown) => rpc('org-a', 'bob', channel, payload);

  // The sample (its metrics run along a date column), plus a dataset with no date at all.
  const seed = await context.runInContext(who('org-a', 'ann'), 'seed', async () => {
    const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const pid = String((await sample.seedSampleProject()).projectId);
    const flat = await datasets.saveDataset(pid, { name: 'Flat', sourceKind: 'csv', columns: [{ name: 'amount', type: 'number' }], rows: [[1.5], [2.25]] });
    if (!flat) throw new Error('dataset not saved');
    return { pid, flat: flat.id };
  });
  const P = seed.pid;
  const metrics = (await ann('metric:list', { projectId: P })).body.metrics as Array<{ id: string; name: string; direction?: 'up_good' | 'down_good' }>;
  ok('the sample has metrics to follow', metrics.length >= 3, String(metrics.length));

  // ── 3. Nothing followed: suggestions ──────────────────────────────────────
  let got = await ann('numbers:get', { projectId: P });
  ok('numbers:get: 200', got.status === 200 && got.body.ok === true, JSON.stringify(got.body).slice(0, 200));
  ok('nothing followed: no tiles, the project\'s first three metrics as suggestions', got.body.tiles.length === 0
    && JSON.stringify(got.body.suggestions.map((s: { id: string }) => s.id)) === JSON.stringify(metrics.slice(0, 3).map((m) => m.id)));
  ok('…and the menu lists every metric, none followed', got.body.choices.filter((c: { kind: string }) => c.kind === 'metric').length === metrics.length
    && got.body.choices.every((c: { followed: boolean }) => !c.followed));

  // ── 1. A dated metric's tile is metric:series' last period ────────────────
  const m0 = metrics[0];
  ok('Ann follows a metric', (await ann('numbers:follow', { projectId: P, kind: 'metric', id: m0.id, on: true })).body.ok === true);
  got = await ann('numbers:get', { projectId: P });
  const tile = got.body.tiles[0];
  const series = (await direct('metric:series', { projectId: P, id: m0.id })).series as { labels: string[]; values: Array<number | null>; display: string[] };
  const n = series.values.length;
  ok('followed: one tile, no suggestions', got.body.tiles.length === 1 && tile.id === m0.id && got.body.suggestions.length === 0);
  ok('the figure is the series\' last period, as it formats it', n > 1 && Object.is(tile.display, series.display[n - 1]), `${tile.display} vs ${series.display[n - 1]}`);
  ok('the sparkline is the series itself', tile.spark.length === n && tile.spark.every((v: number | null, i: number) => Object.is(v, series.values[i])));
  ok('the period is the last one\'s, in words', typeof tile.period === 'string' && tile.period.length > 0 && !/^\d{4}-\d{2}$/.test(tile.period), tile.period);
  const [last, prev] = [series.values[n - 1], series.values[n - 2]];
  if (typeof last === 'number' && typeof prev === 'number' && prev !== 0 && last !== prev) {
    ok('the change is the last two points\' (read independently)', tile.change?.text === changeText(last, prev) && tile.change.up === last > prev, JSON.stringify(tile.change));
    const tone = !m0.direction ? 'neutral' : (m0.direction === 'down_good') === (last < prev) ? 'good' : 'bad';
    ok('…good or bad by the metric\'s own direction', tile.change.tone === tone, `${tile.change.tone} vs ${tone}`);
  } else {
    ok('the change is absent when the last two points cannot give one', tile.change === null, JSON.stringify(tile.change));
  }

  // A metric with no date column: its whole figure, metric:value's.
  const flatM = (await ann('metric:save', { projectId: P, input: { name: 'Flat total', datasetId: seed.flat, definition: { column: 'amount', aggregation: 'sum' } } })).body.metric as { id: string };
  await ann('numbers:follow', { projectId: P, kind: 'metric', id: flatM.id, on: true });
  const flatTile = (await ann('numbers:get', { projectId: P })).body.tiles.find((x: { id: string }) => x.id === flatM.id);
  const flatValue = await direct('metric:value', { projectId: P, id: flatM.id });
  ok('no date column: the tile is metric:value\'s total, with no period, change or sparkline', !!flatTile && Object.is(flatTile.display, flatValue.display)
    && flatTile.period === null && flatTile.change === null && flatTile.spark === null, JSON.stringify(flatTile));

  // A scorecard's tile is its computed counts.
  const sc = (await ann('scorecard:create', { projectId: P, name: 'Goals', period: 'month', rows: [{ metricId: m0.id, target: 1e15 }, { metricId: metrics[1].id }] })).body.scorecard as { id: string };
  await ann('numbers:follow', { projectId: P, kind: 'scorecard', id: sc.id, on: true });
  const goals = (await ann('numbers:get', { projectId: P })).body.tiles.find((x: { id: string }) => x.id === sc.id);
  const computed = (await ann('scorecard:compute', { projectId: P, id: sc.id })).body;
  ok('a scorecard\'s tile is scorecard:compute\'s counts', !!goals && goals.kind === 'scorecard' && Object.is(goals.off, computed.counts.off) && Object.is(goals.warn, computed.counts.warn)
    && Object.is(goals.good, computed.counts.good) && goals.scored === computed.counts.good + computed.counts.warn + computed.counts.off && goals.period === computed.window.label, JSON.stringify({ goals, counts: computed.counts }));

  // ── 2. Following is the caller's own ──────────────────────────────────────
  const bobs = await bob('numbers:get', { projectId: P });
  ok('Bob sees none of Ann\'s follows, and the suggestions', bobs.status === 200 && bobs.body.tiles.length === 0 && bobs.body.suggestions.length === 3, `${bobs.status} ${JSON.stringify(bobs.body).slice(0, 200)}`);
  ok('Bob follows his own', (await bob('numbers:follow', { projectId: P, kind: 'metric', id: metrics[2].id, on: true })).body.ok === true
    && (await bob('numbers:get', { projectId: P })).body.tiles.map((x: { id: string }) => x.id).join() === metrics[2].id);
  ok('…which leaves Ann\'s as they were', (await ann('numbers:get', { projectId: P })).body.tiles.map((x: { id: string }) => x.id).join() === [m0.id, flatM.id, sc.id].join());
  ok('unfollow removes only that one', (await ann('numbers:follow', { projectId: P, kind: 'scorecard', id: sc.id, on: false })).body.ok === true
    && (await ann('numbers:get', { projectId: P })).body.tiles.map((x: { id: string }) => x.id).join() === [m0.id, flatM.id].join());

  // ── 4. Refusals ───────────────────────────────────────────────────────────
  const unknown = await ann('numbers:follow', { projectId: P, kind: 'metric', id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', on: true });
  ok('an unknown metric is refused', unknown.body.ok === false, JSON.stringify(unknown.body));
  for (const m of metrics.slice(1)) await ann('numbers:follow', { projectId: P, kind: 'metric', id: m.id, on: true });
  const more = await Promise.all([1, 2].map((i) => ann('metric:save', { projectId: P, input: { name: `Flat ${i}`, datasetId: seed.flat, definition: { column: 'amount', aggregation: 'max' } } })));
  for (const r of more) await ann('numbers:follow', { projectId: P, kind: 'metric', id: r.body.metric.id, on: true });
  const count = (await ann('numbers:get', { projectId: P })).body.tiles.length;
  ok(`at most FOLLOW_MAX (${config.FOLLOW_MAX}) a project; the next is refused with a reason`, count === config.FOLLOW_MAX, String(count));
  await ann('metric:delete', { projectId: P, id: flatM.id });
  ok('a deleted metric drops out of the tiles', !(await ann('numbers:get', { projectId: P })).body.tiles.some((x: { id: string }) => x.id === flatM.id));
  ok('a kind that is not followable → 400', (await ann('numbers:follow', { projectId: P, kind: 'dataset', id: seed.flat, on: true })).status === 400);
  ok('another org\'s caller → 403', (await rpc('org-b', 'eve', 'numbers:get', { projectId: P })).status === 403);
}

(async () => {
  context.enterServerMode(DATA);
  duck.forbidSyncOnMainThread();
  const pool = poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 4, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) => {
    const [org, user, role] = [h['x-test-org'], h['x-test-user'], h['x-test-role']];
    return typeof org === 'string' && typeof user === 'string' ? who(org, user, role === 'viewer' ? 'viewer' : 'admin') : null;
  });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
    await suite();
  } finally {
    await app.close();
    pool.shutdown();
    duck.setRouter(null);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
