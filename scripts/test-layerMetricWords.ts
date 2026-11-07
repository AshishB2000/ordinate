// What a layer's metric says where Ordinate cannot answer it (semantic layer part 7, b3; docs/semantic-layer/07-portability.md
// D13, D16), over the real RPC route (scripts/liveRouteHarness.ts) and the fake layer (scripts/semanticFake.ts).
//
//   § words    the paths that never ask a layer (key drivers, a scenario, the rows behind a figure, a metric tree's split,
//              a pivot) name the layer of a known backend, typed `external_metric` reason `layer`; an unknown backend keeps
//              b0's "finish the upgrade" (part 5 step 09's split between a kind this pod knows and one it does not)
//   § names    a story's metric block asks the layer through the KPI door; a reference line, a report export and the Metrics
//              table name a layer's metric and say why it has no figure, never "Missing metric" or a blank row
//
//   npm run build:ts && node scripts/test-layerMetricWords.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';

const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const ext: typeof import('../src/analysis/externalMetric') = require('../src/analysis/externalMetric');
const xmsg: typeof import('../src/analysis/externalMetricMessages') = require('../src/analysis/externalMetricMessages');
const smsg: typeof import('../src/engine/semanticMessages') = require('../src/engine/semanticMessages');
const drill: typeof import('../src/ipc/drillScope') = require('../src/ipc/drillScope');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const fake: typeof import('./semanticFake') = require('./semanticFake');

const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
fake.registerSemanticFake();
adapters.registerTestSemanticAdapter('fake', { encode: (q, model) => ({ kind: 'semantic', body: { table: model, columns: H.fx.COLUMNS, query: q }, columns: sq.answerColumns(q) }) });

void (async () => {
  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;
  const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(H.ORG_A, fn);
  const said = (fn: () => string): Promise<string> => as(async () => fn());
  const CONN = await as(async () => (await H.connections.saveConnection(P, { name: 'Layer prod', connectorId: fake.SEMANTIC_FAKE_ID, values: {} }))!.id);
  const SEM = await as(async () => (await liveRecord.saveSemanticRecord(P, {
    name: 'Orders layer', connId: CONN, columns: [], semantic: { backend: 'fake', model: 'live_typed', metrics: [], grains: [], syncedAt: '2026-11-01T00:00:00.000Z' },
  }))!.id);
  await post('dataset:syncLiveSchema', { projectId: P, datasetId: SEM });
  fake.layerFake.describe = async () => { const m = fake.fixtureModel(); return { ...m, metrics: m.metrics.filter((x) => x.name !== 'max_amount') }; };
  await post('dataset:syncLiveSchema', { projectId: P, datasetId: SEM }); // max_amount: dropped by the layer, its mirror kept
  fake.resetLayerFake();
  const all = await as(() => metrics.listMetrics(P));
  const mirror = (n: string): string => all.find((m) => m.datasetId === SEM && m.name === n)!.id;
  const R = mirror('revenue');
  const M = mirror('max_amount');
  const measure = (m: string) => ({ column: '', aggregation: 'sum', metricId: m });
  const ON_LAYER = await said(() => xmsg.externalOnLayer('revenue', 'Fake layer'));
  const onLayer = (r: Reply | undefined): boolean => !!r && r.ok === false && r.code === ext.EXTERNAL_CODE && r.reason === 'layer' && r.error === ON_LAYER;

  // ── § words ──
  const drivers = (await post('drivers:explain', { projectId: P, request: { datasetId: SEM, metric: measure(R), compare: { mode: 'latest', column: 'd' } } })).value;
  ok('key drivers of a layer\'s metric: the layer by name, typed', onLayer(drivers), show(drivers));
  const sc = (await post('scenario:create', { projectId: P, input: { name: 'S', baseMetricIds: [R], drivers: [] } })).value;
  const scenario = (await post('scenario:compute', { projectId: P, id: sc.scenario?.id, draft: { baseMetricIds: [R], drivers: [] } })).value;
  ok('a scenario on a layer\'s metric: the layer by name, typed', onLayer(scenario), show(scenario));
  const meta = await as(() => H.datasets.getDatasetMeta(P, SEM));
  const rows = await as(() => drill.drillInputs(P, SEM, meta!, { metricId: R, encoding: { values: [measure(R)] }, filters: [] } as never));
  ok('the rows behind a layer\'s figure: the layer by name', !rows.ok && 'reason' in rows && rows.reason === ON_LAYER, show(rows));
  ok('a metric tree\'s split and a pivot word it the same (one sentence for the paths that never ask a layer)', await as(async () => {
    const err = ext.noRowsError({ name: 'revenue', definition: { external: 'revenue', layer: 'fake' } });
    return err.message === ON_LAYER && err.reason === 'layer' && ext.isExternalMetricError(err);
  }));
  const unknown = await as(async () => ext.noRowsError({ name: 'revenue', definition: { external: 'revenue', layer: 'zzz' } }));
  ok('NEGATIVE CONTROL: a backend this pod has no name for keeps b0\'s sentence', unknown.reason === 'pending' && unknown.message === (await said(() => xmsg.externalPending('revenue'))), unknown.message);
  ok('…and a tagged reply keeps its reason', await as(async () => {
    const r = ext.tagExternalRefusals({ ok: false, error: ON_LAYER }) as Reply;
    return r.code === ext.EXTERNAL_CODE && r.reason === 'layer';
  }));

  // ── § names ──
  const value = ((await post('metric:values', { projectId: P, ids: [R] })).value as unknown as Reply[])[0];
  const story = (await post('story:figures', { projectId: P, blocks: [{ id: 'b', kind: 'metric', metricId: R }, { id: 'c', kind: 'metrics_row', metricIds: [R, M] }] })).value;
  ok('a story\'s metric block asks the layer through the KPI door', story.blocks?.b?.figures?.[0]?.display === value.display && story.blocks.b.figures[0].name === 'revenue', show(story));
  const missing = await said(() => smsg.layerMetricMissing('Fake layer', 'max_amount'));
  ok('…a block with a mirror the layer dropped says so, typed', story.blocks?.c?.ok === false && story.blocks.c.error === missing && story.blocks.c.code === 'live_refused', show(story.blocks?.c));
  const lines = (await post('visual:data', { projectId: P, datasetId: SEM, encoding: { category: 'region', values: [measure(R)] },
    analytics: [{ id: 'o', kind: 'reference', value: { type: 'metric', metricId: R } }, { id: 'p', kind: 'reference', value: { type: 'metric', metricId: M } }] })).value;
  const line = (id: string): Reply | undefined => (lines.data?.analytics as Reply[] | undefined)?.find((a) => a.id === id);
  ok('a reference line from a layer\'s metric is drawn at its figure', line('o')?.label === 'revenue' && line('o')?.value === value.value, show(lines.data?.analytics));
  ok('…one from a dropped mirror names it, never "Missing metric"', line('p')?.label === 'max_amount' && line('p')?.value === undefined, show(line('p')));
  const table = (await post('metric:table', { projectId: P })).value;
  ok('the Metrics table: a dropped mirror\'s row says why it has no figure', table.rows[M]?.display === null && table.rows[M]?.refused?.error === missing && table.rows[M].refused.reason === 'metricMissing', show(table.rows[M]));
  ok('…every mirror\'s row names its layer', table.rows[R]?.layer === 'Fake layer' && table.rows[M]?.layer === 'Fake layer' && table.rows[R].display === value.display && !('refused' in table.rows[R]), show(table.rows[R]));
  const plain = await as(() => metrics.saveMetric(P, { name: 'Amount', datasetId: s.extractId, definition: { column: 'amt', aggregation: 'sum' } }));
  const plainRow = (await post('metric:table', { projectId: P })).value.rows[plain!.id];
  ok('NEGATIVE CONTROL: a plain metric\'s row is as before (no layer, no refusal key)', !!plainRow && typeof plainRow.display === 'string' && !('layer' in plainRow) && !('refused' in plainRow), show(plainRow));

  await close();
  finish();
})();
