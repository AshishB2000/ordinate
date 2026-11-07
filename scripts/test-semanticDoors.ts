// A semantic dataset's figures through the three doors (semantic layer part 7, b2; docs/semantic-layer/07-portability.md
// D12, D13, D16): charts, KPI tiles and answers on a semantic dataset are asked of the layer, through `vizDataFor`,
// `computeCardMetric` and `computeCard`, over the real RPC route (scripts/liveRouteHarness.ts) and the fake layer
// (scripts/semanticFake.ts), whose metrics are b1's FAKE_METRICS over the parity fixture.
//
//   § doors     every door's figure on the semantic dataset equals the extract's with equal Ordinate metrics
//               (Object.is; sum/avg within the documented 1e-13), series named by the mirror, one question per chart
//   § refusals  every D16 code at its door with the layer's sentence; NEGATIVE CONTROL a running total of an additive
//               mirror; always-applied filters and Live calcs refused (cross-part check 14) with negative controls
//   § values    `dataset:distinct`, the Assistant's spelling lookup and a scorecard's anchor: one dimension-only question
//               to the layer each, as the extract answers them; a backend without lookups refuses `layerLookup`
//
//   npm run build:ts && node scripts/test-semanticDoors.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const compile: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const retail: typeof import('../src/analysis/retailCalendar') = require('../src/analysis/retailCalendar');
const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const fake: typeof import('./semanticFake') = require('./semanticFake');
const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');

const { ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x)).slice(0, 500);
fake.registerSemanticFake();
adapters.registerTestSemanticAdapter('fake', { encode: (q, model) => ({ kind: 'semantic', body: { table: model, columns: H.fx.COLUMNS, query: q }, columns: sq.answerColumns(q) }) });

/** Each layer metric and the extract's equal Ordinate metric: a sum or an average within 1e-13, a count or a max by Object.is. */
const TWINS: Array<{ layer: string; name: string; def: { column: string; aggregation: string }; tolerant: boolean }> = [
  { layer: 'revenue', name: 'Revenue X', def: { column: 'amt', aggregation: 'sum' }, tolerant: true },
  { layer: 'orders', name: 'Orders X', def: { column: 'many', aggregation: 'count' }, tolerant: false },
  { layer: 'avg_amount', name: 'Avg X', def: { column: 'amt', aggregation: 'avg' }, tolerant: true },
  { layer: 'max_amount', name: 'Max X', def: { column: 'amt', aggregation: 'max' }, tolerant: false },
];
const SIX_MONTHS = [{ type: 'filter', column: 'd', op: 'period', period: { preset: 'last_n_months', n: 6 } }];
const WEST = { type: 'filter', column: 'region', op: '=', value: 'West' };

void (async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const X = s.extractId;
  const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(ORG_A, fn);
  const raw = (d: string): Promise<Reply> => as(async () => JSON.parse(await fs.promises.readFile(rec.datasetFilePath(P, d), 'utf8')));
  const CONN = await as(async () => (await H.connections.saveConnection(P, { name: 'Layer prod', connectorId: fake.SEMANTIC_FAKE_ID, values: {} }))!.id);
  const SEM = await as(async () => (await liveRecord.saveSemanticRecord(P, {
    name: 'Orders layer', connId: CONN, columns: [], semantic: { backend: 'fake', model: 'live_typed', metrics: [], grains: [], syncedAt: '2026-11-01T00:00:00.000Z' },
  }))!.id);
  const synced = (await post('dataset:syncLiveSchema', { projectId: P, datasetId: SEM })).value;
  ok('the semantic dataset syncs', synced.ok === true, show(synced));
  const all = await as(() => metrics.listMetrics(P));
  const mirror = (n: string): string => all.find((m) => m.datasetId === SEM && m.name === n)!.id;
  const twinIds = new Map<string, string>();
  for (const t of TWINS) twinIds.set(t.layer, (await as(() => metrics.saveMetric(P, { name: t.name, datasetId: X, definition: t.def })))!.id);
  const onSem = (layer: string) => ({ column: '', aggregation: 'sum', metricId: mirror(layer) });
  const onExt = (layer: string) => ({ ...TWINS.find((t) => t.layer === layer)!.def, metricId: twinIds.get(layer)! });
  const tolerantAt = (layers: string[]) => (i: number): boolean => TWINS.find((t) => t.layer === layers[i])!.tolerant;
  const PLAIN_LIVE = s.liveId;

  /** The two charts' figures, label by label; the semantic one's series named as the extract's (the names are checked apart). */
  const chartsAgree = (label: string, e: Reply, l: Reply, layers: string[], split = false): void => {
    if (!e || e.ok !== true || !l || l.ok !== true) {
      ok(`${label}: both answer`, false, show({ e, l }));
      return;
    }
    const ext = { labels: e.data.labels, series: e.data.series.map((x: Reply) => ({ name: x.name, values: x.values })) };
    const sem = { labels: l.data.labels, series: l.data.series.map((x: Reply, i: number) => ({ name: split ? x.name : ext.series[i]?.name, values: x.values })) };
    const problems = cmp.compareCharts(ext, sem, split ? () => tolerantAt(layers)(0) : tolerantAt(layers), split);
    ok(`${label}: the semantic figures equal the extract's`, problems.length === 0, problems.join(' | '));
  };
  const kpisAgree = (label: string, e: Reply, l: Reply, layer: string): void =>
    ok(`${label}: the semantic figure equals the extract's`, !!e && !!l && e.ok !== false && l.ok !== false && typeof l.value === 'number'
      && cmp.sameNumber(e.value, l.value, TWINS.find((t) => t.layer === layer)!.tolerant), show([e?.value, l]));

  // ── § doors ──
  const ALL4 = TWINS.map((t) => t.layer);
  const enc = (d: string, layers: string[], over: Record<string, unknown> = {}) => ({ category: 'region', values: layers.map((x) => (d === SEM ? onSem(x) : onExt(x))), ...over });
  const chart = async (d: string, layers: string[], over: Record<string, unknown> = {}, filters: unknown[] = []): Promise<Reply> =>
    (await post('visual:data', { projectId: P, datasetId: d, encoding: enc(d, layers, over), filters })).value;
  const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
  const before = trace.snapshot();
  chartsAgree('visual:data, a text axis, all four metrics', await chart(X, ALL4), await chart(SEM, ALL4), ALL4);
  const after = trace.snapshot();
  ok('…a layer\'s question is counted under its backend (live:semantic-fake), never as a DuckDB statement',
    (after['live:semantic-fake']?.warehouse ?? 0) > (before['live:semantic-fake']?.warehouse ?? 0) && (after['live:duckdb']?.warehouse ?? 0) === (before['live:duckdb']?.warehouse ?? 0), JSON.stringify([before['live:duckdb'], after['live:semantic-fake']]));
  chartsAgree('visual:data, 60 categories ("Other" asked of the layer)', await chart(X, ['avg_amount'], { category: 'many' }), await chart(SEM, ['avg_amount'], { category: 'many' }), ['avg_amount']);
  chartsAgree('visual:data, a month axis under a relative period', await chart(X, ['revenue', 'avg_amount'], { category: 'd', grain: 'month' }, SIX_MONTHS),
    await chart(SEM, ['revenue', 'avg_amount'], { category: 'd', grain: 'month' }, SIX_MONTHS), ['revenue', 'avg_amount']);
  chartsAgree('visual:data, a split', await chart(X, ['orders'], { category: 'cat', series: 'region' }), await chart(SEM, ['orders'], { category: 'cat', series: 'region' }), ['orders'], true);
  chartsAgree('visual:data, under a filter', await chart(X, ['max_amount'], {}, [WEST]), await chart(SEM, ['max_amount'], {}, [WEST]), ['max_amount']);
  const batch = async (d: string): Promise<Reply[]> => (await post('visual:dataBatch', { projectId: P, items: [{ datasetId: d, encoding: enc(d, ['revenue']) }, { datasetId: d, encoding: enc(d, ['orders'], { category: 'd', grain: 'quarter' }) }] })).value as unknown as Reply[];
  const [be, bl] = [await batch(X), await batch(SEM)];
  chartsAgree('visual:dataBatch item 1', be[0], bl[0], ['revenue']);
  chartsAgree('visual:dataBatch item 2', be[1], bl[1], ['orders']);
  const tiles = async (d: string, layer: string): Promise<Reply[]> => (await post('analysis:tiles', { projectId: P, items: [
    { kind: 'visual', datasetId: d, encoding: enc(d, [layer]) },
    { kind: 'metric', datasetId: d, ...(d === SEM ? onSem(layer) : onExt(layer)) },
    { kind: 'metric', datasetId: d, ...(d === SEM ? onSem(layer) : onExt(layer)), filters: SIX_MONTHS, compare: { mode: 'previous_period' } },
  ] })).value as unknown as Reply[];
  for (const t of TWINS) {
    const [e, l] = [await tiles(X, t.layer), await tiles(SEM, t.layer)];
    chartsAgree(`analysis:tiles chart (${t.layer})`, e[0], l[0], [t.layer]);
    kpisAgree(`analysis:tiles KPI, metric:value (${t.layer})`, e[1], l[1], t.layer);
    ok(`analysis:tiles KPI (${t.layer}): dated live`, l[1]?.asOf?.mode === 'live', show(l[1]));
    const [ec, lc] = [e[2]?.compare as Reply, l[2]?.compare as Reply];
    ok(`metric:compare, the previous period (${t.layer}): both figures and the delta equal`, !!lc && lc.ok === true && ['value', 'previous', 'delta'].every((k) => cmp.sameNumber(ec?.[k], lc[k], t.tolerant)), show([ec, lc]));
    const values = async (id: string): Promise<Reply> => ((await post('metric:values', { projectId: P, ids: [id], filters: [WEST] })).value as unknown as Reply[])[0];
    kpisAgree(`metric:values (${t.layer})`, await values(twinIds.get(t.layer)!), await values(mirror(t.layer)), t.layer);
  }
  const rule = (d: string, layer: string) => ({ name: 'r', datasetId: d, metric: d === SEM ? onSem(layer) : onExt(layer), compare: 'threshold', threshold: { op: '>', value: 10 }, enabled: true });
  for (const layer of ['revenue', 'orders']) {
    const [e, l] = [(await post('alerts:test', { projectId: P, rule: rule(X, layer) })).value, (await post('alerts:test', { projectId: P, rule: rule(SEM, layer) })).value];
    ok(`alerts:test (${layer}): the same figure, the same verdict`, l.ok === true && cmp.sameNumber(e.value, l.value, TWINS.find((t) => t.layer === layer)!.tolerant) && e.fire === l.fire, show([e, l]));
  }
  const card = async (d: string, layers: string[], over: Record<string, unknown> = {}): Promise<Reply> =>
    (await post('answer:card', { projectId: P, spec: { datasetId: d, category: 'cat', measures: layers.map((x) => (d === SEM ? onSem(x) : onExt(x))), filters: [], chartType: 'bar', title: 'T', top: 5, ...over } })).value;
  {
    const [e, l] = [await card(X, ['revenue']), await card(SEM, ['revenue'])];
    const problems = e.ok && l.ok ? cmp.compareCharts(e.data, { labels: l.data.labels, series: l.data.series.map((x: Reply, i: number) => ({ ...x, name: e.data.series[i]?.name })) }, () => true, false) : ['not both answered'];
    ok('answer:card: the ranked, cut chart equals the extract\'s', problems.length === 0, problems.concat(show([e.reason, l.reason])).join(' | '));
  }
  for (const t of TWINS) {
    const [e, l] = [await as(() => automation.metricValue({ projectId: P } as never, t.name)), await as(() => automation.metricValue({ projectId: P } as never, t.layer))];
    kpisAgree(`MCP metric_value (${t.layer})`, e as Reply, l as Reply, t.layer);
  }
  const named = await chart(SEM, ['revenue', 'orders']);
  ok('a chart\'s series carry the mirror\'s Ordinate name', named.ok === true && named.data.series[0].name === 'revenue' && named.data.series[1].name === 'orders', show(named.data?.series?.map((x: Reply) => x.name)));
  H.queryCache.clear();
  fake.resetLayerFake();
  await chart(SEM, ['revenue'], { category: 'cat' });
  await chart(SEM, ['revenue'], { category: 'cat' });
  ok('one question per chart, cached by the IR', fake.layerFake.calls.length === 1, String(fake.layerFake.calls.length));
  const compiled = { n: 0 };
  const realCompile = compile.compileChart;
  (compile as { compileChart: typeof realCompile }).compileChart = (...a: Parameters<typeof realCompile>) => { compiled.n += 1; return realCompile(...a); };
  H.queryCache.clear();
  await chart(SEM, ['revenue'], { category: 'region' });
  ok('no SQL is compiled for a semantic dataset (compileChart never runs)', compiled.n === 0, String(compiled.n));
  (compile as { compileChart: typeof realCompile }).compileChart = realCompile;

  // ── § refusals ──
  const refusalOf = (r: Reply): { reason: string; error: string } => ({ reason: String(r?.reason ?? ''), error: String(r?.error ?? '') });
  const saveF = async (name: string, formula: string): Promise<string> => (await as(() => metrics.saveMetric(P, { name, datasetId: SEM, definition: { formula } })))!.id;
  const OVER = await saveF('Revenue per order', '[revenue] / [orders]');
  await as(() => rec.serialized(rec.datasetFilePath(P, SEM), (r) => {
    const b = r.semantic as Reply;
    r.semantic = { ...b, metrics: b.metrics.filter((m: Reply) => m.name !== 'max_amount') };
  }));
  H.queryCache.clear();
  const tile = async (metricId: string): Promise<Reply> => ((await post('analysis:tiles', { projectId: P, items: [{ kind: 'metric', datasetId: SEM, column: '', aggregation: 'sum', metricId }] })).value as unknown as Reply[])[0];
  const pivotOf = { rows: [{ column: 'region' }], columns: [], values: [onSem('revenue')] };
  const D16: Array<[string, () => Promise<Reply>]> = [
    ['pivot', () => chart(SEM, ['revenue'], { pivot: pivotOf, values: [] })],
    ['cohort', () => chart(SEM, ['revenue'], { cohort: { entity: 'many', date: 'd', grain: 'month' } })],
    ['funnel', () => chart(SEM, ['revenue'], { eventFunnel: { entity: 'many', event: 'cat', time: 'd', steps: ['Alpha', 'beta'] } })],
    ['facet', () => chart(SEM, ['revenue'], { facet: { rows: 'cat' } })],
    ['drivers', () => chart(SEM, ['revenue'], { drivers: { metric: { metricId: mirror('revenue') }, compare: { mode: 'latest', column: 'd' } } })],
    ['map', () => chart(SEM, ['revenue'], { geo: { level: 'country' } })],
    ['raw', () => chart(SEM, [], { values: [{ ...onSem('revenue'), aggregation: 'none' }] })],
    ['related', () => chart(SEM, ['revenue'], { categoryDatasetId: X })],
    ['bins', () => chart(SEM, ['revenue'], { category: 'amt' })],
    ['weekRollup', async () => {
      await as(async () => retail.setActiveWeekCal({ calendarType: '454' }));
      try { return await chart(SEM, ['revenue'], { category: 'd', grain: 'month' }); } finally { await as(async () => retail.setActiveWeekCal(null)); }
    }],
    ['autoGrain', () => chart(SEM, ['revenue'], { category: 'd' })],
    ['nonAdditiveCalc', () => chart(SEM, [], { values: [{ ...onSem('avg_amount'), calc: { kind: 'running_total' } }] })],
    ['formulaOverLayer', () => chart(SEM, [], { values: [{ column: '', aggregation: 'sum', metricId: OVER }] })],
    ['columnOnLayer', () => chart(SEM, [], { values: [{ column: 'amt', aggregation: 'sum' }] })],
    ['columnOnLayer', async () => (await post('dashboard:metric', { projectId: P, datasetId: SEM, column: 'amt', aggregation: 'sum' })).value],
    ['metricMissing', () => chart(SEM, ['max_amount'])],
    ['metricMissing', () => tile(mirror('max_amount'))],
  ];
  for (const [code, ask] of D16) {
    fake.resetLayerFake();
    const r = refusalOf(await ask());
    // A table calculation is judged on the drawn reply (part 1's refuseNonAdditiveCalcs): asked, never shown.
    ok(`${code}: refused at its door with the layer's sentence${code === 'nonAdditiveCalc' ? '' : ', asking it nothing'}`, r.reason === code && /Fake layer/.test(r.error) && (code === 'nonAdditiveCalc' || fake.layerFake.calls.length === 0), show(r));
  }
  const overKpi = ((await post('metric:values', { projectId: P, ids: [OVER] })).value as unknown as Reply[])[0];
  ok('formulaOverLayer: a KPI of a formula over mirrors is refused, typed, with the layer\'s sentence', overKpi.ok === false && overKpi.code === 'live_refused' && /^A formula can't use revenue: Fake layer/.test(String(overKpi.error)) && !('value' in overKpi), show(overKpi));
  const additive = await chart(SEM, [], { values: [{ ...onSem('revenue'), calc: { kind: 'running_total' } }] });
  ok('NEGATIVE CONTROL: a running total of an additive mirror is drawn', additive.ok === true, show(additive));
  ok('a KPI on a missing mirror never falls back to "deleted"', !/was deleted|deleted/.test(JSON.stringify(await tile(mirror('max_amount')))));
  const answered = await card(SEM, ['revenue'], { category: 'many', series: 'region', top: 5 });
  const sqlAnswered = (await post('answer:card', { projectId: P, spec: { datasetId: PLAIN_LIVE, category: 'many', series: 'region', measures: [{ column: 'amt', aggregation: 'sum' }], filters: [], chartType: 'bar', title: 'T', top: 5 } })).value;
  // b1's named difference (splitOtherLast): a split's "Other" ranks after the kept categories, where the SQL path ranks it
  // by its total — a fifth question. Pinned: a top N over a split cuts the SQL path's top N categories, never its "Other".
  const kept = (r: Reply): string[] => (r.data?.labels ?? []).filter((l: string) => l !== 'Other');
  ok('PINNED: a split answer\'s top 5 over 60 categories is the SQL path\'s, less any "Other" it ranks among them', answered.ok === true && sqlAnswered.ok === true
    && !answered.data.labels.includes('Other') && show(kept(sqlAnswered)) === show(answered.data.labels.slice(0, kept(sqlAnswered).length)), show([answered.data?.labels, sqlAnswered.data?.labels]));

  // ── § values ──
  await as(() => rec.serialized(rec.datasetFilePath(P, SEM), (r) => {
    const b = r.semantic as Reply;
    r.semantic = { ...b, metrics: [...b.metrics, { name: 'max_amount', additive: false }] };
  }));
  H.queryCache.clear();
  const distinct = async (d: string, column: string, more: Record<string, unknown> = {}): Promise<Reply> => (await post('dataset:distinct', { projectId: P, datasetId: d, column, limit: 200, ...more })).value;
  fake.resetLayerFake();
  const [dx, ds] = [await distinct(X, 'many'), await distinct(SEM, 'many')];
  ok('dataset:distinct: the layer\'s values, as the extract lists them', Array.isArray(ds.values) && ds.values.length === 60 && show(ds.values) === show(dx.values) && ds.total === dx.total, show([dx, ds]));
  ok('…one counted question, a dimension and no metric', fake.layerFake.calls.length === 1 && fake.layerFake.calls[0].body.query.metrics.length === 0
    && fake.layerFake.calls[0].body.query.dimensions.length === 1, show(fake.layerFake.calls.map((c) => c.body.query)));
  const [sx, ss] = [await distinct(X, 'many', { search: 'M5' }), await distinct(SEM, 'many', { search: 'M5' })];
  ok('…searched (case-blind) as the extract searches', show(ss.values) === show(sx.values) && ss.values.length === 10, show([sx, ss]));
  const [rx, rs] = [await distinct(X, 'region'), await distinct(SEM, 'region')];
  ok('…a column the layer answers in another order: the same values', show([...rs.values].sort()) === show([...rx.values].sort()), show([rx, rs]));
  const [px, ps] = [await distinct(X, 'many', { filters: [WEST] }), await distinct(SEM, 'many', { filters: [WEST] })];
  ok('…under a cascading picker\'s parent: the layer narrows it', show(ps.values) === show(px.values) && ps.narrowed === undefined, show([px, ps]));
  const def = registry.getConnector(fake.SEMANTIC_FAKE_ID)!;
  registry.registerTestConnector({ ...def, id: 'semantic-fake-nolookups', semantic: { ...def.semantic!, caps: { lookups: false, binaryCompare: false } } });
  const C2 = await as(async () => (await H.connections.saveConnection(P, { name: 'Layer, no lookups', connectorId: 'semantic-fake-nolookups', values: {} }))!.id);
  const NOL = await as(async () => (await liveRecord.saveSemanticRecord(P, { name: 'No lookups', connId: C2, columns: H.fx.COLUMNS, semantic: (await raw(SEM)).semantic }))!.id);
  fake.resetLayerFake();
  const nol = await distinct(NOL, 'many');
  ok('a backend without lookups: dataset:distinct refuses layerLookup, asking nothing', nol.ok === false && nol.reason === 'layerLookup' && /Fake layer/.test(String(nol.error)) && fake.layerFake.calls.length === 0, show(nol));
  const spelled = async (d: string): Promise<Reply> => card(d, ['revenue'], { category: 'cat', filters: [{ column: 'region', op: 'in', values: ['north', 'SOUTH '] }] });
  {
    const [e, l] = [await spelled(X), await spelled(SEM)];
    const problems = e.ok && l.ok ? cmp.compareCharts(e.data, { labels: l.data.labels, series: l.data.series.map((x: Reply, i: number) => ({ ...x, name: e.data.series[i]?.name })) }, () => true, false) : ['not both answered'];
    ok('answer:card, a typed value spelled as the layer holds it: the extract\'s chart', problems.length === 0, problems.concat(show([e.reason, l.reason])).join(' | '));
    ok('…the same case-fixed steps', show(l.steps).includes('"North"') && show(l.steps).includes('"South"'), show(l.steps));
  }
  fake.resetLayerFake();
  const nolCard = await spelled(NOL);
  ok('…on a backend without lookups the spelling lookup refuses layerLookup, asking nothing', nolCard.ok === false && /look up/.test(String(nolCard.reason)) && /Fake layer/.test(String(nolCard.reason)) && fake.layerFake.calls.length === 0, show(nolCard));
  const scorecard = async (metricId: string): Promise<Reply> => {
    const id = (await post('scorecard:create', { projectId: P, name: `C ${metricId.slice(0, 4)}`, period: 'month', rows: [{ metricId }] })).value.scorecard.id as string;
    return (await post('scorecard:compute', { projectId: P, id, offset: 0 })).value as Reply;
  };
  // The extract twin anchors elsewhere (its own day-grain read), so a scorecard is held to the SQL path: a plain Live
  // dataset over the same table, whose anchor is its latest day too.
  const PL = (await as(() => metrics.saveMetric(P, { name: 'Revenue L', datasetId: PLAIN_LIVE, definition: { column: 'amt', aggregation: 'sum' } })))!.id;
  const [scl, scs] = [await scorecard(PL), await scorecard(mirror('revenue'))];
  ok('scorecard:compute: anchored on the layer\'s latest day, as the SQL path on its own', show(scs.rows?.[0]?.sparkLabels) === show(scl.rows?.[0]?.sparkLabels) && (scs.rows?.[0]?.sparkLabels ?? []).at(-1) === 'Mar 2025', show([scl.rows?.[0]?.sparkLabels, scs.rows?.[0]?.sparkLabels]));
  kpisAgree('scorecard:compute (revenue)', scl.rows?.[0], scs.rows?.[0], 'revenue');
  ok('…and its sparkline', (scs.rows?.[0]?.spark ?? []).length === 12 && (scl.rows?.[0]?.spark ?? []).every((v: number | null, i: number) => cmp.sameNumber(v, scs.rows[0].spark[i], true)), show([scl.rows?.[0]?.spark, scs.rows?.[0]?.spark]));

  // Cross-part check item 14: always-applied filters and Live calcs never reach a layer.
  const base = (await post('live:setBaseFilters', { projectId: P, datasetId: SEM, filters: [WEST] })).value;
  ok('live:setBaseFilters on a semantic dataset is refused, and nothing is stored', base.ok === false && /Fake layer/.test(String(base.error)) && !('baseFilters' in (await raw(SEM))), show(base));
  const plainBase = (await post('live:setBaseFilters', { projectId: P, datasetId: PLAIN_LIVE, filters: [WEST] })).value;
  ok('NEGATIVE CONTROL: the same call on a plain Live dataset stores the filter', plainBase.ok === true && 'baseFilters' in (await raw(PLAIN_LIVE)), show(plainBase));
  await post('live:setBaseFilters', { projectId: P, datasetId: PLAIN_LIVE, filters: [] });
  const calcBody = (d: string, ch: string) => (ch === 'live:setCalculated' ? { projectId: P, datasetId: d, calculated: [{ name: 'Double', expression: '[amt] * 2' }] } : { projectId: P, datasetId: d, expression: '[amt] * 2' });
  for (const ch of ['live:setCalculated', 'live:checkCalc']) {
    const r = (await post(ch, calcBody(SEM, ch))).value;
    ok(`${ch} on a semantic dataset: refused formulaOverLayer, nothing stored`, r.ok === false && r.reason === 'formulaOverLayer' && /Fake layer/.test(String(r.error)) && !('calculated' in (await raw(SEM))), show(r));
  }
  const checked = (await post('live:checkCalc', calcBody(PLAIN_LIVE, 'live:checkCalc'))).value;
  ok('NEGATIVE CONTROL: live:checkCalc on a plain Live dataset types the expression', checked.ok === true, show(checked));

  await close();
  finish();
})();
