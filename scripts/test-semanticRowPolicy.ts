// Restricted callers on a semantic dataset (semantic layer part 7, b2; docs/semantic-layer/07-portability.md D17), over
// the real RPC route as real users with real grants, in a scratch Postgres (scripts/rowPolicyHarness.ts), and the fake
// layer (scripts/semanticFake.ts) over the parity fixture. The plan-level checks are in test-rowPolicyLive § semantic.
//
//   rows      a viewer with a row rule on the dataset (east) is refused `layerRowPolicy` at visual:data, the KPI tile,
//             answer:card, dataset:distinct and the Assistant's spelling lookup, the layer asked nothing; dashboard:metric
//             (a column KPI, never a layer's figure) refuses too. NEGATIVE CONTROL: the editor answers at each.
//   compare   a backend declaring `binaryCompare` plans the lock: east's chart is the editor's under region = East
//   columns   a caller from whom a column rule hides a field (west) is refused `layerRowPolicy` whatever the backend
//             declares; NEGATIVE CONTROL: the rule's named team (east) answers
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-semanticRowPolicy.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const fake: typeof import('./semanticFake') = require('./semanticFake');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');

type Body = Record<string, any>; // any: each channel's own reply
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);

(async () => {
  const W = await H.world('semantic row access');
  if (!W) return finish();
  try {
    fake.registerSemanticFake();
    adapters.registerTestSemanticAdapter('fake', { encode: (q, model) => ({ kind: 'semantic', body: { table: model, columns: fx.COLUMNS, query: q }, columns: sq.answerColumns(q) }) });
    const def = registry.getConnector(fake.SEMANTIC_FAKE_ID)!;
    registry.registerTestConnector({ ...def, id: 'semantic-fake-binary', semantic: { ...def.semantic!, caps: { lookups: true, binaryCompare: true } } });
    const { P } = W;
    await W.as('boss', () => fx.loadWarehouse('live_typed', fx.COLUMNS, fx.fixtureRows()));
    const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
    const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
    const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
    const add = (connectorId: string, name: string) => W.as('boss', async () => {
      const conn = (await connections.saveConnection(P, { name: `Layer for ${name}`, connectorId, values: {} }))!; // its own name: a mirror clash takes it
      const ds = (await liveRecord.saveSemanticRecord(P, { name, connId: conn.id, columns: [], semantic: { backend: 'fake', model: 'live_typed', metrics: [], grains: [], syncedAt: '2026-11-01T00:00:00.000Z' } }))!;
      const synced = await W.call('boss', 'dataset:syncLiveSchema', { projectId: P, datasetId: ds.id });
      if (synced.body?.ok !== true) throw new Error(`sync failed: ${synced.text}`);
      const revenue = (await metrics.listMetrics(P)).find((m) => m.datasetId === ds.id && m.name.startsWith('revenue'))!.id;
      return { id: ds.id, revenue };
    });
    const SEM = await add(fake.SEMANTIC_FAKE_ID, 'Layer orders');
    const BIN = await add('semantic-fake-binary', 'Layer orders, exact');
    const COLS = await add('semantic-fake-binary', 'Layer orders, a hidden field');
    for (const d of [SEM.id, BIN.id]) {
      const set = await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: d, policy: { column: 'region', rules: H.RULES(W.team, W.uid.west) } });
      ok(`row rules set on ${d === SEM.id ? 'the layer\'s dataset' : 'the exact one'}`, set.body?.ok === true, set.text);
    }
    const hide = await W.call('boss', 'dataset:setColumnAccess', { projectId: P, datasetId: COLS.id, columns: [{ column: 'cat', visibleTo: [{ teamId: W.team }] }] });
    ok('a column rule set: cat is the East team\'s', hide.body?.ok === true, hide.text);

    const measure = (m: string) => ({ column: '', aggregation: 'sum', metricId: m });
    const DOORS: Array<[string, (d: { id: string; revenue: string }) => [string, unknown], (b: Body) => unknown]> = [
      ['visual:data', (d) => ['visual:data', { projectId: P, datasetId: d.id, encoding: { category: 'region', values: [measure(d.revenue)] } }], (b) => b],
      ['a KPI tile (metric:value)', (d) => ['analysis:tiles', { projectId: P, items: [{ kind: 'metric', datasetId: d.id, ...measure(d.revenue) }] }], (b) => (b as Body[])?.[0]],
      ['answer:card', (d) => ['answer:card', { projectId: P, spec: { datasetId: d.id, category: 'region', measures: [measure(d.revenue)], filters: [], chartType: 'bar', title: 'T' } }], (b) => b],
      ['the Assistant\'s spelling lookup', (d) => ['answer:card', { projectId: P, spec: { datasetId: d.id, category: 'many', measures: [measure(d.revenue)], filters: [{ column: 'region', op: 'in', values: ['east'] }], chartType: 'bar', title: 'T' } }], (b) => b],
      ['dataset:distinct', (d) => ['dataset:distinct', { projectId: P, datasetId: d.id, column: 'many' }], (b) => b],
    ];
    /** The layer's sentence for a restricted caller: in `error`, or (an answer card) in `reason`. */
    const layerRefused = (r: Body | undefined): boolean => !!r && r.ok === false && (r.reason === 'layerRowPolicy' || /limited to some rows, and Fake layer/.test(String(r.reason ?? ''))) && /Fake layer/.test(String(r.error ?? r.reason));
    for (const [what, req, pick] of DOORS) {
      fake.resetLayerFake();
      const [ch, payload] = req(SEM);
      const r = await W.call('east', ch, payload);
      const got = pick(r.body);
      ok(`rows: ${what} refuses east layerRowPolicy, asking the layer nothing`, r.status === 200 && layerRefused(got as Body) && fake.layerFake.calls.length === 0, show([r.status, got]));
      ok(`…its reply carries no row value`, !H.leaks(r.text) && !/North|South|West/.test(r.text), r.text.slice(0, 200));
      const e = await W.call('ed', ch, payload);
      const okd = pick(e.body) as Body;
      ok(`NEGATIVE CONTROL: the editor is answered at ${what}`, e.status === 200 && !!okd && okd.ok !== false && (Array.isArray(okd.values) || !!okd.data || typeof okd.value === 'number'), show(okd));
    }
    fake.resetLayerFake();
    const colKpi = await W.call('east', 'dashboard:metric', { projectId: P, datasetId: SEM.id, column: 'amt', aggregation: 'sum' });
    ok('dashboard:metric (a column KPI, never a layer\'s figure) refuses east too, asking nothing', colKpi.body?.ok === false && fake.layerFake.calls.length === 0 && !H.leaks(colKpi.text), colKpi.text.slice(0, 200));

    // compare: a backend that compares exactly plans the lock.
    const enc = (d: { revenue: string }) => ({ category: 'cat', values: [measure(d.revenue)] });
    const east = (await W.call('east', 'visual:data', { projectId: P, datasetId: BIN.id, encoding: enc(BIN) })).body as Body;
    const edEast = (await W.call('ed', 'visual:data', { projectId: P, datasetId: BIN.id, encoding: enc(BIN), filters: [{ type: 'filter', column: 'region', op: '=', value: 'East' }] })).body as Body;
    const edAll = (await W.call('ed', 'visual:data', { projectId: P, datasetId: BIN.id, encoding: enc(BIN) })).body as Body;
    const chart = (b: Body) => ({ labels: b.data.labels, series: b.data.series.map((s: Body) => ({ name: s.name, values: s.values })) });
    ok('compare: east\'s chart on a backend with binaryCompare is the editor\'s under region = East (Object.is)', east?.ok === true && edEast?.ok === true
      && cmp.compareCharts(chart(edEast), chart(east), () => true, false).length === 0, show([east, edEast]));
    ok('…NEGATIVE CONTROL: and not the editor\'s unlocked one', edAll?.ok === true && cmp.compareCharts(chart(edAll), chart(east), () => true, false).length > 0);
    ok('…the lock reached the layer as a binary filter', fake.layerFake.calls.some((c) => JSON.stringify(c.body.query.where).includes('"binary":true')));

    // columns: a hidden field refuses, whatever the backend declares.
    for (const [what, req, pick] of DOORS) {
      fake.resetLayerFake();
      const [ch, payload] = req(COLS);
      const r = await W.call('west', ch, payload);
      ok(`columns: ${what} refuses west (cat is hidden from them) layerRowPolicy, on a backend with binaryCompare`, layerRefused(pick(r.body) as Body) && fake.layerFake.calls.length === 0, show(r.body));
      const e = await W.call('east', ch, payload);
      const named = pick(e.body) as Body;
      ok(`NEGATIVE CONTROL: the rule's named team answers at ${what}`, !!named && named.ok !== false, show(named));
    }
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
