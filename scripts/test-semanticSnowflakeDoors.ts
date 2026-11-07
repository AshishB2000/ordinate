// A Snowflake semantic dataset through the three doors (semantic layer part 7, c1; docs/live-data/snowflake-semantic-views.md):
// the SHIPPED `snowflake` connector and encoder — not a test connector — over the real RPC route
// (scripts/liveRouteHarness.ts), its SQL API answered in-process (scripts/semanticFakeSnowflake.ts): SHOW and DESCRIBE
// from a held view, and every SEMANTIC_VIEW statement decoded and answered by the fake layer over the parity fixture.
//
//   § doors     the sync from DESCRIBE; charts, "Other", a month axis under a relative period (the latest-day lookup),
//               a split, a filter, a batch, KPI tiles and a comparison, metric:values, answer:card and a value list,
//               each equal to the extract's with equal Ordinate metrics (Object.is; sum/avg within 1e-13); every
//               statement Snowflake saw carries no filter value and the live QUERY_TAG; NEGATIVE CONTROL a filtered
//               semantic chart is not the unfiltered extract's
//   § refusals  each D16 code at its door with "Snowflake" in the sentence and no statement sent; a row lock refused
//               (`binaryCompare` is false until the nightly pins TO_BINARY), asking nothing
//   § secrets   Snowflake's error text carrying the PAT reaches the log redacted and no reply
//   § nightly   scripts/warehouseLiveSnowflakeSemantic.ts end to end against the in-process view (its checks count here)
//
// This proves our encoder and the connector's plumbing against our engine; that Snowflake itself answers the same
// is the warehouse nightly's (scripts/warehouseLiveSnowflakeSemantic.ts).
//
//   npm run build:ts && node scripts/test-semanticSnowflakeDoors.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';
import { captureLogs } from './logCapture';

const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const sf: typeof import('../src/connectors/snowflake') = require('../src/connectors/snowflake');
const secretsIpc: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
const liveTarget: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const sfFake: typeof import('./semanticFakeSnowflake') = require('./semanticFakeSnowflake');
const { FakeSnowflake }: typeof import('./snowflakeFake') = require('./snowflakeFake');

const { ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x)).slice(0, 600);
const PAT = `ver:1-hint:9-SFPAT${Date.now().toString(36)}canary`;
const MODEL = 'SALES.PUBLIC.ORDERS_SV';
const VIEW: import('./semanticFakeSnowflake').FakeView = {
  name: MODEL, comment: 'Every order', table: 'live_typed', columns: H.fx.COLUMNS,
  metrics: { revenue: 'SUM(parity."amt")', orders: 'COUNT(parity."many")', avg_amount: 'AVG(parity."amt")', max_amount: 'MAX(parity."amt")' },
};
const TWINS: Array<{ layer: string; def: { column: string; aggregation: string }; tolerant: boolean }> = [
  { layer: 'revenue', def: { column: 'amt', aggregation: 'sum' }, tolerant: true },
  { layer: 'orders', def: { column: 'many', aggregation: 'count' }, tolerant: false },
  { layer: 'avg_amount', def: { column: 'amt', aggregation: 'avg' }, tolerant: true },
  { layer: 'max_amount', def: { column: 'amt', aggregation: 'max' }, tolerant: false },
];
const tolerantOf = (layer: string): boolean => TWINS.find((t) => t.layer === layer)!.tolerant;
const SIX_MONTHS = [{ type: 'filter', column: 'd', op: 'period', period: { preset: 'last_n_months', n: 6 } }];
const WEST = { type: 'filter', column: 'region', op: '=', value: 'West' };

const fake = new FakeSnowflake();
let hook: ((statement: string) => import('../src/connectors/snowflakeHttp').SfHttpResponse | undefined) | undefined;
fake.answer = sfFake.semanticAnswer([VIEW], (s) => hook?.(s));
sf.setTransport(fake.transport);
const questions = (): string[] => fake.statements().filter((s) => s.includes('SEMANTIC_VIEW('));

void (async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const X = s.extractId;
  const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(ORG_A, fn);
  const CONN = await as(async () => {
    const c = await H.connections.saveConnection(P, { name: 'Snowflake prod', connectorId: 'snowflake', values: { account: 'myorg-acct', user: 'ORDINATE', auth: 'pat', warehouse: 'WH', role: 'ORDINATE_READER', database: 'SALES' } });
    await secretsIpc.storeSecrets(c!.id, { token: PAT });
    return c!.id;
  });

  // ── § doors ──
  const listed = (await post('connection:semanticModels', { projectId: P, connId: CONN })).value;
  ok('Connections lists the semantic views of the Snowflake connection', listed.ok === true && show(listed.models?.map((m: Reply) => m.name)) === show([MODEL]), show(listed));
  const added = (await post('connection:addSemanticDataset', { projectId: P, connId: CONN, model: MODEL, name: 'Orders (Snowflake)' })).value;
  ok('…and one is added as a dataset', added.ok === true && typeof added.dataset?.id === 'string', show(added));
  const SEM: string = added.dataset.id;
  ok('…its dimensions are the view\'s, as DESCRIBE SEMANTIC VIEW types them (no table, no SQL stored)',
    show(added.dataset.columns) === show(H.fx.COLUMNS.map((c) => ({ name: c.name, type: c.type }))), show(added.dataset.columns));
  let mirrors: Awaited<ReturnType<typeof metrics.listMetrics>> = [];
  for (let i = 0; i < 300 && mirrors.length < 4; i += 1) {
    mirrors = (await as(() => metrics.listMetrics(P))).filter((m) => m.datasetId === SEM);
    if (mirrors.length < 4) await new Promise((r) => setTimeout(r, 10));
  }
  ok('…the queued sync mirrors the view\'s four metrics, SUM and COUNT marked as adding up', mirrors.length === 4
    && show(mirrors.map((m) => [m.name, (m.definition as { additive?: boolean }).additive === true]).sort()) === show([['avg_amount', false], ['max_amount', false], ['orders', true], ['revenue', true]]), show(mirrors));
  const mirror = (n: string): string => mirrors.find((m) => m.name === n)!.id;
  const twin = new Map<string, string>();
  for (const t of TWINS) twin.set(t.layer, (await as(() => metrics.saveMetric(P, { name: `${t.layer} X`, datasetId: X, definition: t.def })))!.id);
  const onSem = (layer: string) => ({ column: '', aggregation: 'sum', metricId: mirror(layer) });
  const onExt = (layer: string) => ({ ...TWINS.find((t) => t.layer === layer)!.def, metricId: twin.get(layer)! });
  const enc = (d: string, layers: string[], over: Record<string, unknown> = {}) => ({ category: 'region', values: layers.map((x) => (d === SEM ? onSem(x) : onExt(x))), ...over });
  const chart = async (d: string, layers: string[], over: Record<string, unknown> = {}, filters: unknown[] = []): Promise<Reply> =>
    (await post('visual:data', { projectId: P, datasetId: d, encoding: enc(d, layers, over), filters })).value;
  const agree = (label: string, e: Reply, l: Reply, layers: string[], split = false): string[] => {
    if (!e || e.ok !== true || !l || l.ok !== true) return [`not both answered: ${show({ e, l })}`];
    const ext = { labels: e.data.labels, series: e.data.series.map((x: Reply) => ({ name: x.name, values: x.values })) };
    const sem = { labels: l.data.labels, series: l.data.series.map((x: Reply, i: number) => ({ name: split ? x.name : ext.series[i]?.name, values: x.values })) };
    return cmp.compareCharts(ext, sem, split ? () => tolerantOf(layers[0]) : (i) => tolerantOf(layers[i]), split);
  };
  const charts = async (label: string, layers: string[], over: Record<string, unknown> = {}, filters: unknown[] = [], split = false): Promise<void> => {
    const p = agree(label, await chart(X, layers, over, filters), await chart(SEM, layers, over, filters), layers, split);
    ok(`${label}: the Snowflake figures equal the extract's`, p.length === 0, p.join(' | '));
  };
  const ALL4 = TWINS.map((t) => t.layer);
  await charts('visual:data, a text axis, all four metrics', ALL4);
  const before = questions().length;
  await charts('visual:data, 60 categories ("Other" asked of the view)', ['avg_amount'], { category: 'many' });
  ok('…"Other" was a second statement, excluding the 50 kept inside the clause', questions().length - before === 2 && /WHERE NOT \(/.test(questions().at(-1)!), show(questions().slice(before)));
  await charts('visual:data, a month axis under a relative period (the latest day looked up first)', ['revenue', 'avg_amount'], { category: 'd', grain: 'month' }, SIX_MONTHS);
  ok('…the month truncated inside the clause', questions().some((q) => q.includes("DATE_TRUNC('MONTH', CAST(\"d\" AS DATE)) AS \"d0\"")));
  await charts('visual:data, a split', ['orders'], { category: 'cat', series: 'region' }, [], true);
  await charts('visual:data, under a filter', ['max_amount'], {}, [WEST]);
  for (const g of ['week', 'quarter', 'year']) await charts(`visual:data, a date axis by ${g}`, ['orders'], { category: 'd', grain: g });
  const batch = async (d: string): Promise<Reply[]> => (await post('visual:dataBatch', { projectId: P, items: [{ datasetId: d, encoding: enc(d, ['revenue']) }, { datasetId: d, encoding: enc(d, ['orders'], { category: 'd', grain: 'quarter' }) }] })).value as unknown as Reply[];
  const [be, bl] = [await batch(X), await batch(SEM)];
  const bp = [...agree('b1', be[0], bl[0], ['revenue']), ...agree('b2', be[1], bl[1], ['orders'])];
  ok('visual:dataBatch: both items equal the extract\'s', bp.length === 0, bp.join(' | '));
  for (const t of TWINS) {
    const tiles = async (d: string): Promise<Reply[]> => (await post('analysis:tiles', { projectId: P, items: [
      { kind: 'metric', datasetId: d, ...(d === SEM ? onSem(t.layer) : onExt(t.layer)) },
      { kind: 'metric', datasetId: d, ...(d === SEM ? onSem(t.layer) : onExt(t.layer)), filters: SIX_MONTHS, compare: { mode: 'previous_period' } },
    ] })).value as unknown as Reply[];
    const [e, l] = [await tiles(X), await tiles(SEM)];
    ok(`analysis:tiles KPI (${t.layer}): the same figure, dated live`, typeof l[0]?.value === 'number' && cmp.sameNumber(e[0]?.value, l[0].value, t.tolerant) && l[0]?.asOf?.mode === 'live', show([e[0], l[0]]));
    const [ec, lc] = [e[1]?.compare as Reply, l[1]?.compare as Reply];
    ok(`metric:compare, the previous period (${t.layer}): both figures and the delta equal`, !!lc && lc.ok === true && ['value', 'previous', 'delta'].every((k) => cmp.sameNumber(ec?.[k], lc[k], t.tolerant)), show([ec, lc]));
    const values = async (id: string): Promise<Reply> => ((await post('metric:values', { projectId: P, ids: [id], filters: [WEST] })).value as unknown as Reply[])[0];
    const [ve, vl] = [await values(twin.get(t.layer)!), await values(mirror(t.layer))];
    ok(`metric:values under a filter (${t.layer})`, typeof vl?.value === 'number' && cmp.sameNumber(ve?.value, vl.value, t.tolerant), show([ve, vl]));
  }
  const card = async (d: string): Promise<Reply> => (await post('answer:card', { projectId: P, spec: { datasetId: d, category: 'cat', measures: [d === SEM ? onSem('revenue') : onExt('revenue')], filters: [], chartType: 'bar', title: 'T', top: 5 } })).value;
  const cp = agree('card', await card(X), await card(SEM), ['revenue']);
  ok('answer:card: the ranked, cut chart equals the extract\'s', cp.length === 0, cp.join(' | '));
  const distinct = async (d: string): Promise<Reply> => (await post('dataset:distinct', { projectId: P, datasetId: d, column: 'many', limit: 200 })).value;
  const [dx, ds] = [await distinct(X), await distinct(SEM)];
  ok('dataset:distinct: the view\'s values (a DIMENSIONS-only statement), as the extract lists them', show(ds.values) === show(dx.values) && ds.values?.length === 60, show([dx, ds]));
  const neg = agree('neg', await chart(X, ['max_amount']), await chart(SEM, ['max_amount'], {}, [WEST]), ['max_amount']);
  ok('NEGATIVE CONTROL: a filtered Snowflake chart is not the unfiltered extract\'s', neg.length > 0);

  const asked = questions();
  ok(`every one of the ${asked.length} statements was decoded back to a question the plan asks`, asked.length > 20 && sfFake.asked.length === asked.length);
  ok('…none carries a filter value in its text (West, the six months\' bounds, the kept categories)', !asked.some((q) => /West|20\d\d-\d\d-\d\d|'m\d\d'/.test(q)), show(asked.filter((q) => /West|20\d\d-|'m\d\d'/.test(q)).slice(0, 1)));
  ok('…each under the live QUERY_TAG, inside the row cap (its own last line, so its ORDER BY holds)', fake.of('submit').filter((x) => String(x.json?.statement).includes('SEMANTIC_VIEW(')).every((x) =>
    (x.json?.parameters as Reply)?.QUERY_TAG === 'ordinate:acme:live' && /^SELECT [\s\S]*\nLIMIT \d+$/.test(String(x.json?.statement)) && Number(/\d+$/.exec(String(x.json?.statement))?.[0]) <= 100_001));

  // ── § refusals ──
  const n0 = questions().length;
  const refusedAt = async (code: string, ask: () => Promise<Reply>): Promise<void> => {
    const r = await ask();
    ok(`${code}: refused at its door, naming Snowflake, no statement sent`, r?.reason === code && /Snowflake/.test(String(r?.error)) && questions().length === n0, show(r));
  };
  await refusedAt('pivot', () => chart(SEM, ['revenue'], { pivot: { rows: [{ column: 'region' }], columns: [], values: [onSem('revenue')] }, values: [] }));
  await refusedAt('bins', () => chart(SEM, ['revenue'], { category: 'amt' }));
  await refusedAt('autoGrain', () => chart(SEM, ['revenue'], { category: 'd' }));
  await refusedAt('columnOnLayer', () => chart(SEM, [], { values: [{ column: 'amt', aggregation: 'sum' }] }));
  await refusedAt('map', () => chart(SEM, ['revenue'], { geo: { level: 'country' } }));
  const found = await as(() => liveTarget.liveTarget(P, SEM));
  const env = found.ok ? found.target.semantic!.env : null;
  const calls: unknown[] = [];
  const locked = env ? await as(() => es.evaluateSemantic({ kind: 'chart', measures: [{ metric: 'revenue' }], category: { column: 'region', kind: 'text' },
    filters: [{ kind: 'in', column: 'region', values: ['East'], negate: false, binary: true }], order: 'natural', weekCal: null }, env, async (q) => { calls.push(q); return { columns: [], rows: [] }; })) : null;
  ok('a row lock on a Snowflake semantic dataset is refused (layerRowPolicy, naming Snowflake), asking nothing: no byte-exact compare is pinned yet',
    !!env && env.caps.binaryCompare === false && !!locked && !locked.ok && locked.code === 'layerRowPolicy' && /Snowflake/.test(locked.message) && calls.length === 0, show(locked));

  // ── § secrets ──
  const logs = captureLogs();
  hook = (st) => (/SEMANTIC_VIEW\(|DESCRIBE SEMANTIC VIEW/.test(st) ? sfFake.sqlApiFailure(`Insufficient privileges for ${PAT} on SALES.PUBLIC.ORDERS_SV`) : undefined);
  H.queryCache.clear();
  const failed = await chart(SEM, ['revenue'], { category: 'cat' });
  const redescribe = await post('dataset:syncLiveSchema', { projectId: P, datasetId: SEM });
  hook = undefined;
  logs.restore();
  const replies = JSON.stringify([failed, redescribe.value]);
  ok('a Snowflake error carrying the PAT: the chart fails typed, and neither the token nor the view\'s name is in the reply', failed.ok === false && !replies.includes(PAT) && !replies.includes('ORDERS_SV'), show(failed));
  ok('…Snowflake\'s words are in the server log for the question and the describe, the token redacted',
    logs.lines.filter((l) => l.includes('Insufficient privileges')).length >= 2 && !logs.lines.some((l) => l.includes(PAT)), show(logs.lines.slice(-3)));
  ok('…and the describe that failed changed nothing: a sentence, the dataset as it was', redescribe.value.ok === false && redescribe.value.code === 'live_failed' && /server log/.test(String(redescribe.value.error)), show(redescribe.value));
  ok('NEGATIVE CONTROL: the reply Snowflake sent did carry the token', sfFake.sqlApiFailure(`x ${PAT}`).body.includes(PAT));

  // ── § nightly ── the warehouse nightly's semantic run, here against the in-process view, so it cannot rot unseen
  // before (or between) real-account runs: its catalog checks, probes, the whole parity matrix and its control.
  const NIGHTLY = 'NIGHTLY.PUBLIC.ORDINATE_SEMANTIC_PARITY_SV';
  fake.answer = sfFake.semanticAnswer([{ ...VIEW, name: NIGHTLY }]);
  const nightly: typeof import('./warehouseLiveSnowflakeSemantic') = require('./warehouseLiveSnowflakeSemantic');
  await as(() => nightly.runSnowflakeSemantic({ account: 'myorg-acct', user: 'ORDINATE', warehouse: 'WH', role: 'ORDINATE_READER', pat: PAT, semanticView: NIGHTLY }));

  sf.setTransport(null);
  await close();
  finish();
})().catch((err: unknown) => {
  ok('the suite reached its end', false, err instanceof Error ? err.stack : String(err));
  finish();
});
