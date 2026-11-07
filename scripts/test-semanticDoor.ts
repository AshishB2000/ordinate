// A semantic layer's questions go through THE ONE Live door (semantic layer part 7, b1; docs/semantic-layer/
// 07-portability.md D18): `warehouse()` takes a `SemanticRequest` beside a compiled statement, and sends it through
// `runSemanticBound` with the same slot, daily count, timeout, signal and logging. A real server-mode process
// (scripts/liveQueryHarness.ts) and the fake layer as a connector (scripts/semanticFake.ts):
//
//   count       a layer question is one query on its connection's usage row; a chart with "Other" is two,
//               a split with "Other" four — and the chart is the one the fake answers directly
//   shape       the rows come back in the request's column order; a missing column is `rowShape`
//   hang-up     a question queued for a slot whose asker hangs up is never sent
//   timeout     LIVE_QUERY_TIMEOUT_MS aborts the layer call
//   leaks       the layer's words reach the server log, never the error a caller sees; the connection's
//               secret reaches neither (a canary); a private host is refused by the SSRF guard first
//
//   npm run build:ts && node scripts/test-semanticDoor.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { LiveTarget } from '../src/engine/live/liveTarget';
import type { SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';
import type { SemanticRunner } from '../src/engine/live/semantic/evaluateSemantic';
import type { SemanticRequest } from '../src/connectors/semanticRun';
import * as H from './liveQueryHarness';

const { randomUUID }: typeof import('crypto') = require('crypto');
const usage: typeof import('../src/server/live/usageStore') = require('../src/server/live/usageStore');
const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const fake: typeof import('./semanticFake') = require('./semanticFake');

const { lq, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);
const CANARY = 'tok-canary-8c41f2';
const TABLE = 'live_typed'; // the harness's warehouse table, in org A's DuckDB worker
fake.registerSemanticFake();

const COUNT_Q: SemanticQuery = { dimensions: [{ name: 'region' }], metrics: ['revenue', 'orders'], where: [], order: [{ by: 'revenue', desc: true }] };
const req = (q: SemanticQuery, columns = sq.answerColumns(q)): SemanticRequest => ({ kind: 'semantic', body: { table: TABLE, columns: H.fx.COLUMNS, query: q }, columns });

function target(s: H.OrgSetup, connectionId: string, connectorId = fake.SEMANTIC_FAKE_ID, values: Record<string, unknown> = {}): LiveTarget {
  return {
    projectId: s.projectId, datasetId: s.liveId, org: ORG_A.org.id, connectionId,
    live: { maxCacheAgeSec: 300, epoch: 0, schemaSyncedAt: '' } as unknown as LiveTarget['live'],
    columns: H.fx.COLUMNS, dialect: 'duckdb', source: { kind: 'table', parts: [TABLE] },
    env: { dialect: 'duckdb', source: { kind: 'table', parts: [TABLE] }, columns: H.fx.COLUMNS }, baseFilters: [],
    def: registry.getConnector(connectorId)!, values, secrets: async () => ({ token: CANARY }),
  };
}

async function queries(connectionId: string): Promise<number> {
  const rows = await H.as(ORG_A, () => usage.readUsage(null, usage.utcDay()));
  return rows.find((r) => r.connectionId === connectionId)?.queries ?? 0;
}

const ENV: SemanticEnv = {
  dataset: 'Fixture', layer: 'Fake layer', columns: H.fx.COLUMNS,
  metrics: new Map(Object.keys(fake.FAKE_METRICS).map((m) => [m, { additive: fake.FAKE_ADDITIVE.has(m) }])),
  grains: new Map([['d', ck.DATE_GRAINS]]), caps: { lookups: true, binaryCompare: false },
};

/** The executor's runner shape: each question through the one door, its rows read back by the request's columns. */
const throughDoor = (t: LiveTarget): SemanticRunner => async (q) => {
  const r = req(q);
  const rows = await lq.warehouse(t, r, new AbortController().signal);
  return spec.isRefusal(rows) ? rows : { columns: r.columns.slice(), rows };
};

async function counted(s: H.OrgSetup): Promise<void> {
  const conn = randomUUID();
  const t = target(s, conn);
  const q0 = await queries(conn);
  const rows = await H.as(ORG_A, () => lq.warehouse(t, req(COUNT_Q), new AbortController().signal));
  ok('a semantic request is counted like a statement', (await queries(conn)) === q0 + 1 && fake.layerFake.calls.length === 1, show(await queries(conn)));
  const c = fake.layerFake.calls[0];
  ok('…with the Live context: costTag live, the Live row cap, the timeout, a signal', c.costTag === 'live' && c.rowLimit === 100_000 && c.timeoutMs > 0 && c.signal instanceof AbortSignal);
  const flipped = await H.as(ORG_A, () => lq.warehouse(t, req(COUNT_Q, ['orders', 'region']), new AbortController().signal));
  ok('the rows come back in the request\'s column order', Array.isArray(rows) && Array.isArray(flipped) && flipped.length === rows.length
    && flipped.every((r, i) => show(r) === show([rows[i][2], rows[i][0]])), show([rows, flipped]));
  const missing = await H.as(ORG_A, () => lq.warehouse(t, req(COUNT_Q, ['region', 'margin']), new AbortController().signal));
  ok('a column the layer did not answer is refused (rowShape), never filled in', spec.isRefusal(missing) && missing.code === 'rowShape', show(missing));
  const sql = await H.as(ORG_A, () => lq.warehouse(t, { sql: 'SELECT 1', params: [], columns: ['x'] }, new AbortController().signal).catch((e: unknown) => e));
  ok('NEGATIVE CONTROL: a compiled statement to a connector with no `live` fails, as before', sql instanceof lq.LiveCallError && sql.kind === 'failed');

  // Through the plan: the very chart the fake answers directly, and its questions counted at the door.
  const enc = { category: 'many', values: [{ column: 'amt', aggregation: 'avg' as const }] };
  const a = spec.fromVizEncoding(enc, [], H.fx.COLUMNS, {});
  const ir = a.ok ? { ...a.ir, measures: [{ metric: 'avg_amount' }] } : null;
  const before = await queries(conn);
  const door = ir ? await H.as(ORG_A, () => es.evaluateSemantic(ir, ENV, throughDoor(t))) : null;
  const direct = ir ? await H.as(ORG_A, () => es.evaluateSemantic(ir, ENV, (q) => fake.runFake(TABLE, H.fx.COLUMNS, q))) : null;
  ok('a chart with "Other" through the door: the same chart, two counted statements', !!door && door.ok && show(door) === show(direct) && (await queries(conn)) === before + 2, show({ door, n: (await queries(conn)) - before }));
  const split = spec.fromVizEncoding({ ...enc, series: 'region' }, [], H.fx.COLUMNS, {});
  const before2 = await queries(conn);
  const got = split.ok ? await H.as(ORG_A, () => es.evaluateSemantic({ ...split.ir, measures: [{ metric: 'avg_amount' }] }, ENV, throughDoor(t))) : split;
  ok('a split with "Other": four counted statements', got.ok && got.kind === 'chart' && !!got.chart.category.note && (await queries(conn)) === before2 + 4, show((await queries(conn)) - before2));
}

async function hangUp(s: H.OrgSetup): Promise<void> {
  fake.resetLayerFake();
  process.env.LIVE_MAX_CONCURRENT = '1';
  const t = target(s, randomUUID());
  const g = H.gate();
  fake.layerFake.hook = async () => { await g.wait(); return undefined; };
  try {
    const first = H.as(ORG_A, () => lq.warehouse(t, req(COUNT_Q), new AbortController().signal));
    await H.until(() => fake.layerFake.calls.length === 1);
    const ac = new AbortController();
    const queued = H.as(ORG_A, () => lq.warehouse(t, req(COUNT_Q), ac.signal).then(() => 'answered', (e: unknown) => e));
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    const gone = await queued;
    g.open();
    await first;
    ok('a hang-up while queued sends nothing', gone instanceof lq.LiveCallError && gone.kind === 'cancelled' && fake.layerFake.calls.length === 1, show({ gone: String(gone), calls: fake.layerFake.calls.length }));
  } finally {
    delete process.env.LIVE_MAX_CONCURRENT;
    fake.resetLayerFake();
  }
}

async function timeout(s: H.OrgSetup): Promise<void> {
  process.env.LIVE_QUERY_TIMEOUT_MS = '150';
  fake.layerFake.hook = async (_c, ctx) => {
    await new Promise<void>((r) => ctx.signal?.addEventListener('abort', () => r(), { once: true }));
    return { ok: false, error: 'Cancelled' };
  };
  try {
    const slow = await H.as(ORG_A, () => lq.warehouse(target(s, randomUUID()), req(COUNT_Q), new AbortController().signal).then(() => null, (e: unknown) => e));
    ok('the timeout aborts the layer call', slow instanceof lq.LiveCallError && slow.kind === 'timeout' && fake.layerFake.calls[0]?.signal?.aborted === true, show(String(slow)));
  } finally {
    delete process.env.LIVE_QUERY_TIMEOUT_MS;
    fake.resetLayerFake();
  }
}

async function leaks(s: H.OrgSetup): Promise<void> {
  fake.layerFake.hook = async () => ({ ok: false, error: `fake layer said: view SALES_V is broken (auth ${CANARY})` });
  try {
    const run = await H.capturingWarn(() => H.as(ORG_A, () => lq.warehouse(target(s, randomUUID()), req(COUNT_Q), new AbortController().signal).then(() => null, (e: unknown) => e)));
    const err = run.value;
    ok('a layer error reaches the log', run.lines.some((l) => l.includes('fake layer said: view SALES_V is broken')), show(run.lines));
    // `detail` is the log's line (liveWarehouse LiveCallError); the executor answers a `failed` with its catalog sentence only.
    ok('…never what a caller is handed: the error says "live failed", its words are the log\'s', err instanceof lq.LiveCallError && err.kind === 'failed' && err.message === 'live failed', show(err));
    ok('the connection\'s secret reaches neither (canary)', !run.lines.join('\n').includes(CANARY) && !String(err).includes(CANARY) && !JSON.stringify(err).includes(CANARY) && run.lines.some((l) => l.includes('auth ***')));
  } finally {
    fake.resetLayerFake();
  }
  const meta = await H.capturingWarn(() => H.as(ORG_A, () => lq.warehouse(target(s, randomUUID(), fake.SEMANTIC_FAKE_NET_ID, { host: '169.254.169.254' }), req(COUNT_Q), new AbortController().signal).then(() => null, (e: unknown) => e)));
  ok('SSRF: a layer aimed at the cloud metadata address is never called', meta.value instanceof lq.LiveCallError && fake.layerFake.calls.length === 0 && meta.lines.some((l) => /link-local/.test(l)), show(meta.lines));
  const pub = await H.as(ORG_A, () => lq.warehouse(target(s, randomUUID(), fake.SEMANTIC_FAKE_NET_ID, { host: '8.8.8.8' }), req(COUNT_Q), new AbortController().signal));
  ok('SSRF NEGATIVE CONTROL: a public address passes, and the layer gets it PINNED', Array.isArray(pub) && fake.layerFake.calls[0]?.pinned === '8.8.8.8');
  fake.resetLayerFake();
  const none = await H.capturingWarn(() => H.as(ORG_A, () => lq.warehouse(target(s, randomUUID(), H.fakeMod.LIVE_FAKE_ID), req(COUNT_Q), new AbortController().signal).then(() => null, (e: unknown) => e)));
  ok('a source with no semantic capability is refused at the door, said in the log', none.value instanceof lq.LiveCallError && none.lines.some((l) => l.includes('cannot answer semantic-layer questions')));
}

// AbortSignal.timeout's timer is unref'd; keep the loop alive while the suite runs.
const keepAlive = setInterval(() => undefined, 1000);

async function main(): Promise<void> {
  ok('the fake layer resolves by id, and no catalog lists it', registry.getConnector(fake.SEMANTIC_FAKE_ID)?.semantic?.backend === 'fake'
    && !registry.listConnectors().some((d) => d.family === 'semantic-fake') && !registry.connectorCatalog().some((e) => e.id === fake.SEMANTIC_FAKE_ID));
  const s = await H.setupOrg(ORG_A);
  await counted(s);
  await hangUp(s);
  await timeout(s);
  await leaks(s);
}

main()
  .catch((e) => ok('semantic door suite threw', false, e && (e as Error).stack))
  .finally(() => {
    clearInterval(keepAlive);
    H.cleanup();
    finish();
  });
