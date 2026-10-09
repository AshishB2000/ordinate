// Every door routed to the warehouse (docs/live-data/00-plan.md L2.4), over the
// real RPC route in server mode, against the fake warehouse (the L2.3 bench).
//
//   doors      visual:data / dataBatch / preview / thumbs, dashboard:metric,
//              metric:value(s) / preview / compare, analysis:tiles,
//              answer:card, alerts:test — each answers on a Live dataset with
//              the figure the EXTRACT of the same rows gives (the parity
//              fixture; sum/avg within the documented 1e-13), dated LIVE, and
//              a spy proves `datasets.getDataset` is never asked for it
//   calls      a dashboard of N live tiles: at most N warehouse calls on first
//              view, ZERO on a second view inside the cache age, counted on the
//              fake's spy through `analysis:tiles`; identical tiles share one
//   publish    the published page (buildDashboard) and the HTML export carry
//              the live figures; `sanitizeBundle` keeps the figures of a
//              bundle built from live replies and drops everything else
//   refusals   pivot, cohort, funnel, drivers, facets, maps, raw points: typed
//              `live_refused`, no chart; an "as of" read, a currency
//              conversion and a filter through a relationship refused at the
//              door — each with a NEGATIVE CONTROL (the extract answers)
//   asOf       the live time survives visual:data's stamp (cached on a hit);
//              `dashboard:asOfStamps` dates a sheet by its extracts only
//   more       a scorecard's window on Live (anchored on the warehouse's latest
//              date) equals the extract over that window; a published story's
//              Live metric, and one its warehouse could not give (the block
//              says why, the rest publishes); the Metrics table's sparkline is
//              NOT routed and says so, typed; a `LiveFigureError` no handler
//              caught is a typed 409 at the route (NEGATIVE CONTROL: a 500)
//   measured   warehouse calls per dashboard load; first vs cached second view
//
//   npm run build:ts && node scripts/test-liveRoute.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, median, post } from './liveRouteHarness';

const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metricsStore: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const dashData: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const pub: typeof import('../src/publish/publish') = require('../src/publish/publish');
const exportMod: typeof import('../src/analysis/dashboardExport') = require('../src/analysis/dashboardExport');
const fxStore: typeof import('../src/app/fxStore') = require('../src/app/fxStore');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const storyData: typeof import('../src/publish/storyData') = require('../src/publish/storyData');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const lfe: typeof import('../src/engine/live/liveFigureError') = require('../src/engine/live/liveFigureError');

const { fake, queryCache, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x));
const M = (column: string, aggregation: string) => ({ column, aggregation });
const ENC_REGION = { category: 'region', values: [M('amt', 'sum')] };
const ENC_MONTH = { category: 'd', grain: 'month', values: [M('amt', 'avg'), M('qty', 'sum')] };
const SIX_MONTHS = [{ type: 'filter', column: 'd', op: 'period', period: { preset: 'last_n_months', n: 6 } }];
const TOLERANT = (): boolean => true; // every figure below is a sum, an avg or a count: within 1e-13, else Object.is

/** A chart reply's figures as the parity comparator reads them. */
function chartOf(r: Reply): import('./liveParityCompare').ChartLike {
  return { labels: r.data.labels, series: r.data.series.map((s: Reply) => ({ name: s.name, values: s.values })) };
}

function sameChart(label: string, ext: Reply, live: Reply): void {
  if (!ext || ext.ok !== true || !live || live.ok !== true) {
    ok(`${label}: both answer`, false, show({ ext, live }).slice(0, 400));
    return;
  }
  const problems = cmp.compareCharts(chartOf(ext), chartOf(live), TOLERANT, false);
  ok(`${label}: the Live figures equal the extract's`, problems.length === 0, problems.join(' | '));
  ok(`${label}: dated by the warehouse (live), the extract by its copy`, live.asOf?.mode === 'live' && ext.asOf?.mode === 'extract', show([live.asOf, ext.asOf]));
}

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  const X = s.extractId;
  duck.forbidSyncOnMainThread();

  // Records each dataset needs: a saved metric, a saved visual.
  const recs = await H.as(ORG_A, async () => {
    const mk = async (d: string, tag: string) => {
      const m = await metricsStore.saveMetric(P, { name: `Sales ${tag}`, datasetId: d, definition: { column: 'amt', aggregation: 'sum' } });
      const v = await visuals.saveVisual(P, { name: `By region ${tag}`, datasetId: d, chartType: 'bar', encoding: ENC_REGION, filters: [] });
      if (!m || !v) throw new Error('records not saved');
      return { metricId: m.id, visualId: v.id };
    };
    return { live: await mk(L, 'live'), extract: await mk(X, 'extract') };
  });

  // ── 1. Every door answers on Live, equal to the extract, never hydrating ──
  const before = hydrated.length;
  const both = async (channel: string, payload: (d: string, r: typeof recs.live) => unknown): Promise<[Reply, Reply]> => {
    const ext = (await post(channel, payload(X, recs.extract))).value;
    const live = (await post(channel, payload(L, recs.live))).value;
    return [ext, live];
  };
  {
    const [e, l] = await both('visual:data', (d) => ({ projectId: P, datasetId: d, encoding: ENC_REGION }));
    sameChart('visual:data, text axis', e, l);
  }
  {
    const [e, l] = await both('visual:data', (d) => ({ projectId: P, datasetId: d, encoding: ENC_MONTH, filters: SIX_MONTHS }));
    sameChart('visual:data, month axis under a relative period', e, l);
  }
  {
    const [e, l] = await both('visual:dataBatch', (d) => ({ projectId: P, items: [{ datasetId: d, encoding: ENC_REGION }, { datasetId: d, encoding: ENC_MONTH }] }));
    const ea = e as unknown as Reply[];
    const la = l as unknown as Reply[];
    sameChart('visual:dataBatch item 1', ea[0], la[0]);
    sameChart('visual:dataBatch item 2', ea[1], la[1]);
  }
  {
    const [e, l] = await both('visual:preview', (d) => ({ projectId: P, datasetId: d, encoding: ENC_REGION }));
    sameChart('visual:preview (the builder)', e, l);
  }
  {
    const [e, l] = await both('visual:thumbs', (_d, r) => ({ projectId: P, ids: [r.visualId] }));
    sameChart('visual:thumbs (the gallery)', (e as unknown as Reply[])[0], (l as unknown as Reply[])[0]);
  }
  {
    const [e, l] = await both('dashboard:metric', (d) => ({ projectId: P, datasetId: d, column: 'amt', aggregation: 'avg', filters: SIX_MONTHS }));
    ok('dashboard:metric: the Live KPI equals the extract\'s, dated live', l.ok === true && cmp.sameNumber(e.value, l.value, true) && l.asOf?.mode === 'live', show([e, l]));
  }
  {
    // A KPI naming a saved metric: `metric:value`, which only the batch reaches.
    const [e, l] = await both('analysis:tiles', (d, r) => ({ projectId: P, items: [{ kind: 'metric', datasetId: d, column: 'amt', aggregation: 'sum', metricId: r.metricId }] }));
    const ea = (e as unknown as Reply[])[0];
    const la = (l as unknown as Reply[])[0];
    ok('metric:value (a saved metric\'s KPI): equal, dated live, displayed by the app', la.ok === true && cmp.sameNumber(ea.value, la.value, true)
      && la.asOf?.mode === 'live' && ea.display === la.display && typeof la.display === 'string', show([ea, la]));
  }
  {
    const [e, l] = await both('metric:values', (_d, r) => ({ projectId: P, ids: [r.metricId] }));
    const ea = (e as unknown as Reply[])[0];
    const la = (l as unknown as Reply[])[0];
    ok('metric:values: equal, dated live', la.ok === true && cmp.sameNumber(ea.value, la.value, true) && la.asOf?.mode === 'live', show([ea, la]));
  }
  {
    const [e, l] = await both('metric:preview', (d) => ({ projectId: P, datasetId: d, definition: { column: 'qty', aggregation: 'max' } }));
    ok('metric:preview (the editor): equal', l.ok === true && Object.is(e.value, l.value), show([e, l]));
  }
  {
    // A KPI with a Compare: `metric:compare` (two figures and the delta), which only the batch reaches.
    const [e, l] = await both('analysis:tiles', (d) => ({ projectId: P, items: [{ kind: 'metric', datasetId: d, column: 'amt', aggregation: 'sum', filters: SIX_MONTHS, compare: { mode: 'previous_period' } }] }));
    const ec = (e as unknown as Reply[])[0].compare as Reply;
    const lc = (l as unknown as Reply[])[0].compare as Reply;
    ok('metric:compare (a KPI\'s delta): both figures and the delta equal', !!lc && lc.ok === true && typeof lc.value === 'number'
      && ['value', 'previous', 'delta'].every((k) => cmp.sameNumber(ec[k], lc[k], true)), show([ec, lc]));
  }
  {
    const tiles = (d: string) => [{ kind: 'visual', datasetId: d, encoding: ENC_REGION }, { kind: 'metric', datasetId: d, column: 'cat', aggregation: 'count' }];
    const [e, l] = await both('analysis:tiles', (d) => ({ projectId: P, items: tiles(d) }));
    const ea = e as unknown as Reply[];
    const la = l as unknown as Reply[];
    sameChart('analysis:tiles chart', ea[0], la[0]);
    ok('analysis:tiles KPI: equal, dated live', la[1].ok === true && Object.is(ea[1].value, la[1].value) && la[1].asOf?.mode === 'live', show([ea[1], la[1]]));
  }
  {
    const spec = (d: string) => ({ datasetId: d, category: 'cat', measures: [M('amt', 'sum')], filters: [{ column: 'region', op: 'in', values: ['north', 'SOUTH '] }], chartType: 'bar', title: 'Sales by cat', top: 5 });
    const [e, l] = await both('answer:card', (d) => ({ projectId: P, spec: spec(d) }));
    const problems = e.ok && l.ok ? cmp.compareCharts(e.data, l.data, TOLERANT, false) : ['not both answered'];
    ok('answer:card: the ranked, cut chart equals the extract\'s', problems.length === 0, problems.concat(show([e.reason, l.reason])).join(' | '));
    ok('answer:card: the same notes, labels (as asked) and case-fixed steps', show(e.notes) === show(l.notes) && show(e.filterLabels) === show(l.filterLabels)
      && show(e.steps) === show(l.steps) && show(l.steps).includes('"North"'), show([e.filterLabels, l.filterLabels, e.steps, l.steps]));
    ok('answer:card: dated live', l.asOf?.mode === 'live' && e.asOf?.mode === 'extract');
  }
  {
    const rule = (d: string) => ({ id: '3f0c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b', datasetId: d, metric: { column: 'amt', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 10 } });
    const [e, l] = await both('alerts:test', (d) => ({ projectId: P, rule: rule(d) }));
    ok('alerts:test (a threshold rule): the same figure, the same verdict', l.ok === true && cmp.sameNumber(e.value, l.value, true) && e.fire === l.fire, show([e, l]));
  }
  const asked = hydrated.slice(before);
  ok('THE SPY: no door asked getDataset for the Live dataset', !asked.includes(L), show(asked));
  ok('…while the extract twin of some door did hydrate (the spy is live)', asked.includes(X), `${asked.length} hydrations`);

  // ── 2. Warehouse calls per dashboard view ─────────────────────────────────
  const TILES = [
    { kind: 'visual', datasetId: L, encoding: ENC_REGION },
    { kind: 'visual', datasetId: L, encoding: { category: 'd', grain: 'quarter', values: [M('amt', 'sum')] } },
    { kind: 'metric', datasetId: L, column: 'amt', aggregation: 'sum' },
    { kind: 'metric', datasetId: L, column: 'cat', aggregation: 'count' },
  ];
  const view = () => post('analysis:tiles', { projectId: P, items: TILES });
  const firsts: number[] = [];
  const seconds: number[] = [];
  let firstCalls = -1;
  let secondCalls = -1;
  for (let i = 0; i < 15; i += 1) {
    queryCache.clear();
    H.fakeMod.resetFake();
    let t = performance.now();
    const a = await view();
    firsts.push(performance.now() - t);
    const c1 = fake.calls.length;
    t = performance.now();
    const b = await view();
    seconds.push(performance.now() - t);
    if (i === 0) {
      firstCalls = c1;
      secondCalls = fake.calls.length - c1;
      ok('dashboard view: every tile answered', (a.value as unknown as Reply[]).every((x) => x.ok === true) && (b.value as unknown as Reply[]).every((x) => x.ok === true));
      ok('…the second view is served from the cache (`cached`)', (b.value as unknown as Reply[]).every((x) => x.asOf?.cached === true), show((b.value as unknown as Reply[]).map((x) => x.asOf)));
    }
  }
  ok(`a dashboard of ${TILES.length} Live tiles: at most ${TILES.length} warehouse calls on first view (${firstCalls})`, firstCalls > 0 && firstCalls <= TILES.length);
  ok(`…and ZERO on a second view inside the cache age (${secondCalls})`, secondCalls === 0);
  console.log(`  measured: ${TILES.length} live tiles → ${firstCalls} warehouse calls, then ${secondCalls}; analysis:tiles first view ${median(firsts).toFixed(2)} ms, cached second view ${median(seconds).toFixed(2)} ms (medians of ${firsts.length}, fake warehouse, no network)`);
  queryCache.clear();
  H.fakeMod.resetFake();
  await post('analysis:tiles', { projectId: P, items: [TILES[0], TILES[0], TILES[2], TILES[2]] });
  ok('four tiles asking two questions: two warehouse calls', fake.calls.length === 2, String(fake.calls.length));
  queryCache.clear();
  H.fakeMod.resetFake();
  await post('analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: L, encoding: { category: 'd', values: [M('amt', 'sum')] } }] });
  ok('a date axis with no grain asks one probe first (two statements), as L2.2 compiles it', fake.calls.length === 2, String(fake.calls.length));
  await H.as(ORG_A, () => H.liveDataset.bumpEpoch(P, L));
  H.fakeMod.resetFake();
  await view();
  ok('after Refresh (an epoch bump) the same view asks the warehouse again', fake.calls.length === firstCalls, String(fake.calls.length));

  // ── 3. Publish and export carry the live figures ───────────────────────────
  const board = await H.as(ORG_A, () => analysis.saveAnalysis(P, {
    name: 'Live board',
    sheets: [{ name: 'One', cards: [
      { type: 'visual', visualId: recs.live.visualId, layout: { x: 0, y: 0, w: 6, h: 6 } },
      { type: 'metric', metric: { datasetId: L, column: 'amt', aggregation: 'sum', label: 'Live total' }, layout: { x: 6, y: 0, w: 3, h: 2 } },
    ] }],
  } as unknown as Parameters<typeof analysis.saveAnalysis>[1]));
  const liveChart = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION })).value;
  const liveKpi = (await post('dashboard:metric', { projectId: P, datasetId: L, column: 'amt', aggregation: 'sum' })).value;
  const pubFrom = hydrated.length;
  const built = board ? await H.as(ORG_A, () => dashData.buildDashboard(P, board.id, 1)) : null;
  const cards = built ? built.sheets[0].cards : [];
  const chartCard = cards.find((c) => c.kind === 'chart');
  const kpiCard = cards.find((c) => c.kind === 'metric');
  const chartPayload = chartCard ? (chartCard.payloads[chartCard.variants[0]] as Reply) : null;
  const kpiPayload = kpiCard ? (kpiCard.payloads[kpiCard.variants[0]] as Reply) : null;
  ok('publish: the chart tile carries the live chart', !!chartPayload && show(chartPayload.labels) === show(liveChart.data.labels)
    && show(chartPayload.series.map((x: Reply) => x.values)) === show(liveChart.data.series.map((x: Reply) => x.values)), show(chartPayload).slice(0, 300));
  ok('publish: the KPI tile carries the live figure', !!kpiPayload && Object.is(kpiPayload.value, liveKpi.value), show([kpiPayload, liveKpi]));
  const html = board ? await H.as(ORG_A, () => pub.dashboardPageHtml(P, board.id)) : '';
  const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(html);
  const page = m ? (JSON.parse(m[1]) as Reply) : null;
  const pageKpi = page ? page.dashboard.sheets[0].cards.find((c: Reply) => c.kind === 'metric') : null;
  ok('export (one self-contained page): the live KPI is in its data', !!pageKpi && Object.is(pageKpi.payloads[pageKpi.variants[0]].value, liveKpi.value), show(pageKpi).slice(0, 300));
  ok('publish and export never hydrated the Live dataset', !hydrated.slice(pubFrom).includes(L));
  // The PDF/PPTX export: the browser's bundle of live replies, through the whitelist.
  const bundle = exportMod.sanitizeBundle({
    name: 'Live board', asOf: liveChart.asOf, secret: H.SECRET_CANARY,
    pages: [{ name: 'One', cards: [
      { kind: 'chart', layout: { x: 0, y: 0, w: 6, h: 6 }, chartType: 'bar', title: 'By region', asOf: liveChart.asOf,
        data: { labels: liveChart.data.labels, series: liveChart.data.series.map((x: Reply) => ({ label: x.name, values: x.values })), asOf: liveChart.asOf, warnings: ['w'] } },
      { kind: 'metric', layout: { x: 6, y: 0, w: 3, h: 2 }, label: 'Live total', value: liveKpi.value, asOf: liveKpi.asOf, code: 'live_failed' },
    ] }],
  });
  const kept = bundle.pages[0].cards;
  ok('sanitizeBundle keeps the live figures', kept.length === 2 && show((kept[0] as Reply).data.series[0].values) === show(liveChart.data.series[0].values)
    && Object.is((kept[1] as Reply).value, liveKpi.value), show(kept).slice(0, 300));
  ok('…and drops everything it does not name (asOf, warnings, codes, a planted secret)', !/asOf|warnings|live_failed|"mode"/.test(JSON.stringify(bundle)) && !JSON.stringify(bundle).includes(H.SECRET_CANARY));

  // ── 4. Typed refusals, never an empty chart ───────────────────────────────
  const refusedAs = (r: Reply, reason: string): boolean => r.ok === false && r.code === 'live_refused' && r.reason === reason && typeof r.error === 'string' && !('data' in r);
  const PIVOT = { ...ENC_REGION, pivot: { rows: [{ column: 'region' }], columns: [], values: [{ column: 'amt', aggregation: 'sum' }] } };
  for (const [label, enc, reason] of [
    ['pivot', PIVOT, 'pivot'],
    ['cohort', { ...ENC_REGION, cohort: { entity: 'cat', date: 'd', grain: 'month' } }, 'cohort'],
    ['event funnel', { ...ENC_REGION, eventFunnel: { entity: 'cat', event: 'region', time: 'd', steps: ['North', 'South'] } }, 'funnel'],
    ['key drivers tile', { ...ENC_REGION, drivers: { metric: { column: 'amt', aggregation: 'sum' }, compare: { mode: 'latest', column: 'd' } } }, 'drivers'],
    ['small multiples', { ...ENC_REGION, facet: { cols: 'cat' } }, 'facet'],
    ['map', { ...ENC_REGION, geo: { level: 'country' } }, 'map'],
    ['raw points', { category: 'region', values: [M('amt', 'none')] }, 'raw'],
  ] as [string, unknown, string][]) {
    const r = (await post('visual:data', { projectId: P, datasetId: L, encoding: enc })).value;
    ok(`Live ${label}: refused, typed (${reason}) — no chart`, refusedAs(r, reason), show(r).slice(0, 240));
  }
  const extPivot = (await post('visual:data', { projectId: P, datasetId: X, encoding: PIVOT })).value;
  ok('negative control: the extract draws the same pivot', extPivot.ok === true, show(extPivot).slice(0, 200));

  // An "as of" read: the warehouse answers now, and a Live dataset keeps no history.
  const now = new Date().toISOString();
  const asOfChart = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION, asOf: now })).value;
  const asOfKpi = (await post('analysis:tiles', { projectId: P, asOf: now, items: [{ kind: 'metric', datasetId: L, column: 'amt', aggregation: 'sum' }] })).value[0] as Reply;
  ok('as of a past time: the Live chart is refused, typed', refusedAs(asOfChart, 'asOf'), show(asOfChart));
  ok('…and the Live KPI', asOfKpi.ok === false && asOfKpi.code === 'live_refused' && asOfKpi.reason === 'asOf', show(asOfKpi));
  const asOfExt = (await post('visual:data', { projectId: P, datasetId: X, encoding: ENC_REGION, asOf: now })).value;
  ok('negative control: the extract reads as of the same time', asOfExt.ok === true, show(asOfExt).slice(0, 200));

  // Currency conversion: the extract converts a declared money column; the warehouse would sum it unconverted.
  await H.as(ORG_A, async () => {
    await fxStore.setProjectFx(P, { target: 'USD' });
    await fxStore.setColumnCurrency(P, L, 'amt', { kind: 'fixed', code: 'EUR' });
    await fxStore.setColumnCurrency(P, X, 'amt', { kind: 'fixed', code: 'EUR' });
  });
  const fxKpi = (await post('dashboard:metric', { projectId: P, datasetId: L, column: 'amt', aggregation: 'sum' })).value;
  const fxChart = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION })).value;
  const fxCount = (await post('dashboard:metric', { projectId: P, datasetId: L, column: 'amt', aggregation: 'count' })).value;
  const fxExt = (await post('dashboard:metric', { projectId: P, datasetId: X, column: 'amt', aggregation: 'sum' })).value;
  ok('a converted money KPI on Live: refused, typed (fx)', fxKpi.ok === false && fxKpi.code === 'live_refused' && fxKpi.reason === 'fx', show(fxKpi));
  ok('…and the converted chart', refusedAs(fxChart, 'fx'), show(fxChart).slice(0, 200));
  ok('negative controls: a count never converts, so it answers; the extract converts', fxCount.ok === true && fxExt.ok === true && !!fxExt.fx, show([fxCount, fxExt]).slice(0, 300));
  await H.as(ORG_A, async () => {
    await fxStore.setColumnCurrency(P, L, 'amt', null);
    await fxStore.setColumnCurrency(P, X, 'amt', null);
  });

  // A filter that only a relationship could answer: joins are L4.
  const zones = await H.as(ORG_A, () => H.datasets.saveDataset(P, {
    name: 'Zones', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'zone', type: 'text' }],
    rows: [['North', 'Z1'], ['South', 'Z1'], ['East', 'Z2'], ['West', 'Z2']],
  }));
  const ZONE = [{ type: 'filter', column: 'zone', op: '=', value: 'Z1' }];
  const unrelated = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION, filters: ZONE })).value;
  ok('negative control: with no relationship, an unknown filter column is skipped with the extract\'s warning', unrelated.ok === true
    && unrelated.warnings.includes('Filter skipped: unknown column "zone"'), show(unrelated).slice(0, 240));
  await H.as(ORG_A, async () => {
    for (const d of [L, X]) await rels.saveRelationship(P, { from: { datasetId: d, column: 'region' }, to: { datasetId: zones!.id, column: 'region' }, cardinality: 'many_to_one' });
  });
  const related = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION, filters: ZONE })).value;
  const relatedKpi = (await post('dashboard:metric', { projectId: P, datasetId: L, column: 'amt', aggregation: 'sum', filters: ZONE })).value;
  const relatedExt = (await post('visual:data', { projectId: P, datasetId: X, encoding: ENC_REGION, filters: ZONE })).value;
  ok('a filter through a relationship on Live: refused, typed (related)', refusedAs(related, 'related'), show(related).slice(0, 240));
  ok('…the KPI too', relatedKpi.ok === false && relatedKpi.code === 'live_refused' && relatedKpi.reason === 'related', show(relatedKpi));
  ok('negative control: the extract answers it through the join', relatedExt.ok === true && relatedExt.warnings.length === 0, show(relatedExt).slice(0, 240));
  await H.as(ORG_A, async () => {
    for (const r of await rels.listRelationships(P)) await rels.deleteRelationship(P, r.id);
  });

  // ── 5. The live time survives the stamp ───────────────────────────────────
  queryCache.clear();
  const t1 = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION })).value;
  const t2 = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION })).value;
  ok('visual:data keeps the warehouse\'s time (not the record\'s), then `cached` on a hit', t1.asOf?.mode === 'live' && !t1.asOf.cached
    && t2.asOf?.mode === 'live' && t2.asOf.cached === true && t2.asOf.at === t1.asOf.at, show([t1.asOf, t2.asOf]));
  const stampsLive = (await post('dashboard:asOfStamps', { projectId: P, datasetIds: [L], metricIds: [] })).value;
  const stampsExt = (await post('dashboard:asOfStamps', { projectId: P, datasetIds: [X], metricIds: [] })).value;
  const stampsBoth = (await post('dashboard:asOfStamps', { projectId: P, datasetIds: [L, X], metricIds: [recs.live.metricId] })).value;
  ok('dashboard:asOfStamps: a Live dataset adds no record time to the sheet\'s "Latest"', stampsLive.ok !== false && !stampsLive.latest
    && show(stampsBoth.latest) === show(stampsExt.latest) && stampsExt.latest?.mode === 'extract', show([stampsLive.latest, stampsExt.latest, stampsBoth.latest]));

  // ── 6. Scorecards, stories, the Metrics table, an uncaught failure ──────
  const moreFrom = hydrated.length;
  const sc = (await post('scorecard:create', { projectId: P, name: 'Live card', period: 'month', rows: [{ metricId: recs.live.metricId }] })).value;
  const card = (await post('scorecard:compute', { projectId: P, id: sc.scorecard?.id, offset: 0 })).value;
  const lastDay = H.fx.fixtureRows().map((r) => r[6]).filter((d): d is string => typeof d === 'string').sort().at(-1);
  const win = card.window ?? {};
  const inWindow = [{ type: 'filter', column: 'd', op: 'period', period: { preset: 'custom', from: win.from, to: win.to } }];
  const extWindow = (await post('dashboard:metric', { projectId: P, datasetId: X, column: 'amt', aggregation: 'sum', filters: inWindow })).value;
  ok('scorecard:compute on a Live metric: anchored on the warehouse\'s latest date, the window\'s figure equals the extract\'s over it', card.ok === true
    && card.anchor === lastDay && cmp.sameNumber(extWindow.value, card.rows?.[0]?.value, true) && card.rows[0].spark.length > 1, show([card.anchor, lastDay, win, card.rows?.[0]?.value, extWindow.value]));

  const story = await H.as(ORG_A, () => stories.saveStory(P, { name: 'Live story', blocks: [
    { kind: 'metric', metricId: recs.live.metricId, filters: [] },
    { kind: 'metrics_row', metricIds: [recs.live.metricId, recs.extract.metricId], filters: [] },
  ] }));
  const metricBlocks = async (): Promise<Reply[]> => ((story ? await H.as(ORG_A, () => storyData.buildStory(P, story.id)) : null)?.blocks ?? []) as Reply[];
  queryCache.clear();
  const told = await metricBlocks();
  ok('a published story: its Live metric is the warehouse\'s figure', told[0]?.kind === 'metrics' && Object.is(told[0].metrics[0].value, liveKpi.value), show(told).slice(0, 300));
  queryCache.clear();
  fake.hook = async () => ({ ok: false, error: 'warehouse down' });
  const down = await H.capturingWarn(() => metricBlocks());
  fake.hook = null;
  ok('…its warehouse down: that block says why (the catalog\'s sentence), the row keeps its extract metric, the story still publishes', down.value[0]?.kind === 'broken'
    && down.value[0].reason === H.msg.liveWarehouseFailed() && down.value[1]?.kind === 'metrics' && down.value[1].metrics.length === 1, show(down.value).slice(0, 300));

  ok('scorecards and stories never hydrated the Live dataset', !hydrated.slice(moreFrom).includes(L), show(hydrated.slice(moreFrom)));

  const table = (await post('metric:table', { projectId: P })).value;
  const liveRow = table.rows?.[recs.live.metricId];
  const extRow = table.rows?.[recs.extract.metricId];
  ok('metric:table: the Live metric\'s value is the warehouse\'s, its sparkline absent (not routed)', !!liveRow && !!extRow && liveRow.display === extRow.display
    && liveRow.series === null && Array.isArray(extRow.series) && extRow.series.length > 1, show([liveRow, extRow]).slice(0, 300));
  const series = (id: string) => H.as(ORG_A, async () => (await rpc.handlers.get('metric:series')!(null, { projectId: P, id })) as Reply);
  const [liveSeries, extSeries] = [await series(recs.live.metricId), await series(recs.extract.metricId)];
  ok('…because metric:series refuses a Live metric, typed (the route tags it live_dataset) — NEGATIVE CONTROL: the extract\'s answers', H.liveDataset.isLiveRefusalReply(liveSeries)
    && extSeries.ok === true && Array.isArray(extSeries.series?.values), show([liveSeries, extSeries]).slice(0, 300));

  // L2.7's daily limit, met at each door: a typed refusal (never an empty figure) — or the last answer, stale.
  queryCache.clear();
  const warm = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION })).value;
  H.budget.setDailyCheckForTest(() => ({ ok: false, message: H.msg.liveDailyLimit('4') }));
  queryCache.clear();
  const dChart = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION })).value;
  const dKpi = (await post('dashboard:metric', { projectId: P, datasetId: L, column: 'amt', aggregation: 'sum' })).value;
  const dAnswer = (await post('answer:card', { projectId: P, spec: { datasetId: L, category: 'cat', measures: [M('amt', 'sum')], filters: [{ column: 'region', op: '=', value: 'north' }], chartType: 'bar', title: 'q' } })).value;
  const daily = (r: Reply, said: string): boolean => r.ok === false && r.code === 'live_refused' && r[said] === H.msg.liveDailyLimit('4');
  ok('the daily limit reached: the chart, the KPI and the answer (its case-fix lookup first) are refused typed, in the catalog\'s sentence',
    daily(dChart, 'error') && dChart.reason === 'dailyLimit' && daily(dKpi, 'error') && dKpi.reason === 'dailyLimit' && daily(dAnswer, 'reason'), show([dChart, dKpi, dAnswer]).slice(0, 400));
  H.budget.setDailyCheckForTest(null);
  const again = (await post('visual:data', { projectId: P, datasetId: L, encoding: ENC_REGION })).value;
  ok('NEGATIVE CONTROL: the limit lifted, the same chart answers — the figure it drew before', again.ok === true && warm.ok === true && show(again.data) === show(warm.data));

  // A LiveFigureError no handler caught: the route types it as it does LiveDatasetError.
  const realMetric = rpc.handlers.get('dashboard:metric')!;
  const swap = async (fn: () => never): Promise<{ status: number; body: string; value: Reply }> => {
    rpc.registry.removeHandler('dashboard:metric');
    rpc.registry.handle('dashboard:metric', fn);
    try {
      return await post('dashboard:metric', { projectId: P, datasetId: L, column: 'amt', aggregation: 'sum' });
    } finally {
      rpc.registry.removeHandler('dashboard:metric');
      rpc.registry.handle('dashboard:metric', realMetric);
    }
  };
  const escaped = await swap(() => { throw new lfe.LiveFigureError({ ok: false, code: 'live_refused', error: H.msg.liveAsOfRefused(), reason: 'asOf' }); });
  const plain = await swap(() => { throw new Error(`boom ${H.SECRET_CANARY}`); });
  ok('an uncaught LiveFigureError: a typed 409 — its code, reason and catalog sentence, nothing else', escaped.status === 409 && escaped.value.code === 'live_refused'
    && escaped.value.reason === 'asOf' && escaped.value.message === H.msg.liveAsOfRefused(), `${escaped.status} ${escaped.body}`);
  ok('NEGATIVE CONTROL: any other uncaught error is still the bare 500, its words in no reply', plain.status === 500 && !plain.body.includes('boom'), `${plain.status} ${plain.body}`);

  // What routing costs an EXTRACT door: one more metadata read (the Live check).
  const metaMs: number[] = [];
  await H.as(ORG_A, async () => {
    for (let i = 0; i < 400; i += 1) {
      const t = performance.now();
      await H.datasets.getDatasetMeta(P, X);
      metaMs.push(performance.now() - t);
    }
  });
  console.log(`  measured: the Live check on an extract door (one getDatasetMeta, records as files) ${median(metaMs).toFixed(3)} ms median of ${metaMs.length}`);

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
