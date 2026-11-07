// The additivity rule (semantic layer part 1, D7): whether a measure can be added up across categories and
// across time, derived from what the measure IS and never typed in. A running total, a percent of total and a
// moving sum add; a chart that asks one of them of a measure that does not add is refused with a sentence.
//
//   rules       the pure rule and its sentences
//   doors       visual:data and visual:preview refuse the calc, with the measure named; an adding measure still runs
//   published   /p/ builds the tile as an error, and a story block as a broken block
//   assistant   the Assistant reads the raw figures of a refused chart
//   overlay     the "up N% vs last year" caption is not written over a measure that can't be added across time
//   facts       the Assistant's facts and `list_metrics` say which metrics can be added up
//   metric:table each row says whether its metric adds up: the rule's own answer, null for a parameter formula
//
//   npm run build:ts && node scripts/test-additivity.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-additivity-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const A: typeof import('../src/analysis/additivity') = require('../src/analysis/additivity');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const ipcVizSample: typeof import('../src/ipc/vizSample') = require('../src/ipc/vizSample');
const ipcAnalysesServer: typeof import('../src/ipc/analysesServer') = require('../src/ipc/analysesServer');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const copilotFacts: typeof import('../src/ai/copilotFacts') = require('../src/ai/copilotFacts');
const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const { paramValues }: typeof import('../src/analysis/params') = require('../src/analysis/params');
const { savedScope }: typeof import('../src/ipc/copilotCards') = require('../src/ipc/copilotCards');
const { buildDashboard }: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const { buildStory }: typeof import('../src/publish/storyData') = require('../src/publish/storyData');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const { aggWord }: typeof import('../src/data/aggregations') = require('../src/data/aggregations');
type Additivity = import('../src/analysis/additivity').Additivity;
type Metric = import('../src/analysis/metrics').Metric;
type Any = any; // any: each handler's own reply shape, read field by field below

const DS = 'ds-1';

// ── rules ────────────────────────────────────────────────────────────────────────────────────────────────────────
const same = (a: Additivity, c: boolean, t: boolean) => Object.is(a.categories, c) && Object.is(a.time, t);
for (const [agg, want] of [['sum', true], ['count', true], ['none', true], ['avg', false], ['min', false], ['max', false], ['countd', false]] as const)
  ok(`aggregation ${agg}`, same(A.aggregationAdditivity(agg), want, want));
const COLS = [{ name: 'revenue', type: 'number' }, { name: 'cost', type: 'number' }, { name: 'day', type: 'date' }, { name: 'units', type: 'number' }] as never as import('../src/data/parse').ParsedColumn[];
const M = (name: string, definition: object) => ({ id: name, name, datasetId: DS, definition, filters: [] }) as never as Metric;
const STOCK = M('Stock', { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } });
const ms = [M('Revenue', { column: 'revenue', aggregation: 'sum' }), M('Cost', { column: 'cost', aggregation: 'sum' }), M('Avg price', { column: 'revenue', aggregation: 'avg' })];
const byName = new Map(ms.map((m) => [m.name.toLowerCase(), m]));
for (const [formula, want] of [['[Revenue] - [Cost]', true], ['sum(revenue) + sum(cost)', true], ['2 * [Revenue]', true],
  ['[Revenue] / [Cost]', false], ['[Revenue] + [Avg price]', false], ['sum(revenue) + 5', false], ['[Missing] + [Revenue]', false]] as const)
  ok(`formula ${formula}`, same(A.additivityOf(M('F', { formula }), COLS, byName), want, want));
ok('snapshot sum: across categories yes, across time no', same(A.additivityOf(STOCK, COLS, byName), true, false));
ok('snapshot avg: neither', same(A.additivityOf(M('Lvl', { column: 'units', aggregation: 'avg', snapshot: { column: 'day', take: 'last' } }), COLS, byName), false, false));
for (const k of ['running_total', 'pct_of_total', 'moving_sum'] as const) ok(`${k} adds`, A.calcNeedsAdditive(k, false) === 'categories' && A.calcNeedsAdditive(k, true) === 'time');
for (const k of ['diff', 'pct_diff', 'rank_dense', 'rank_competition', 'percentile', 'moving_avg', 'yoy', 'index'] as const)
  ok(`${k} adds nothing`, A.calcNeedsAdditive(k, false) === null && A.calcNeedsAdditive(k, true) === null);
ok('avg running total → refused', A.calcRefusal('Avg price', 'running_total', { categories: false, time: false }, false) === msg.calcNotAdditive('Avg price', 'a running total'));
ok('snapshot along dates → the time sentence', A.calcRefusal('Stock', 'running_total', { categories: true, time: false }, true) === msg.calcNotAdditiveOverTime('Stock', 'a running total'));
ok('snapshot across regions → allowed', A.calcRefusal('Stock', 'pct_of_total', { categories: true, time: false }, false) === null);
ok('sum along dates → allowed', A.calcRefusal('Revenue', 'moving_sum', { categories: true, time: true }, true) === null);
ok('avg moving sum along dates → the plain sentence, it is no snapshot', A.calcRefusal('Avg price', 'moving_sum', { categories: false, time: false }, true) === msg.calcNotAdditive('Avg price', 'a moving sum'));
ok('NEGATIVE CONTROL: a kind that adds nothing is never refused', A.calcRefusal('Avg price', 'yoy', { categories: false, time: false }, false) === null);
ok('a formula over a snapshot metric reads as neither (the documented shortcut)', same(A.additivityOf(M('F', { formula: '[Stock] * 2' }), COLS, new Map([...byName, ['stock', STOCK]])), false, false));
ok('NEGATIVE CONTROL: the allow-list refuses an aggregation it does not know', same(A.aggregationAdditivity('median'), false, false) && same(A.aggregationAdditivity(undefined as never), false, false));

// ── fixture ──────────────────────────────────────────────────────────────────────────────────────────────────────
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
/** Wraps an export and counts its calls, as liveRouteHarness wraps `getDataset`. */
function spyOn<T extends object>(mod: T, name: keyof T & string, hit: () => void): void {
  const real = (mod as Any)[name];
  (mod as Any)[name] = (...args: unknown[]) => { hit(); return real(...args); };
}

// Every day of 2023-01 to 2024-02, in two regions. Whole numbers, so every sum is exact.
const ROWS: Array<[string, string, number, number]> = [];
for (let t = Date.UTC(2023, 0, 1); t <= Date.UTC(2024, 1, 29); t += 86_400_000) {
  const day = new Date(t).toISOString().slice(0, 10);
  const n = Math.round(t / 86_400_000);
  ROWS.push([day, 'East', 100 + (n % 17), 2 + (n % 3)], [day, 'West', 60 + (n % 11), 1 + (n % 2)]);
}
const COLUMNS = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'qty', type: 'number' }] as Any;
const RT = { kind: 'running_total', along: 'across' } as const;

async function main(): Promise<void> {
  ipcVisuals.register();
  ipcVizSample.register();
  ipcAnalysesServer.register();
  ipcMetrics.register();
  const viz = handlers.get('visual:data');
  const preview = handlers.get('visual:preview');
  ok('the shipped handlers are registered', !!viz && !!preview);
  if (!viz || !preview) return;
  await projects.init();
  const pid = (await projects.createProject('Additivity')).id;
  const ds = (await datasets.saveDataset(pid, { name: 'Sales', sourceKind: 'csv', columns: COLUMNS, rows: ROWS } as Any))!.id;
  const metric = async (name: string, definition: object) => (await metrics.saveMetric(pid, { name, datasetId: ds, definition }))!;
  await metric('Revenue', { column: 'amount', aggregation: 'sum' });
  await metric('Cost', { column: 'qty', aggregation: 'sum' });
  const profit = await metric('Profit', { formula: '[Revenue] - [Cost]' });
  const perUnit = await metric('Per unit', { formula: '[Revenue] / [Cost]' });
  const scaled = await metric('Scaled', { formula: '[Revenue] * [[k]]' });
  const gone = await metric('Gone', { column: 'amount', aggregation: 'sum' });
  await metrics.deleteMetric(pid, gone.id);
  const stock = await metric('Stock', { column: 'qty', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } });
  const chart = (encoding: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    viz(null, { projectId: pid, datasetId: ds, encoding, filters: [], ...extra }) as Promise<Any>;

  // ── doors ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const avgRT = await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: RT }] });
  ok('avg running total → refused with its sentence', avgRT.ok === false && avgRT.code === 'calc_not_additive' && avgRT.error === msg.calcNotAdditive('avg of amount', 'a running total'), show(avgRT));
  const sumRT = await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'sum', calc: RT }] });
  ok('NEGATIVE CONTROL: sum running total still runs', sumRT.ok && sumRT.data.series[0].calc?.kind === 'running_total' && Object.is(sumRT.data.series[0].values.at(-1), sumRT.data.series[0].raw.reduce((a: number, b: number) => a + b, 0)), show(sumRT));
  for (const [agg, kind] of [['max', 'pct_of_total'], ['min', 'moving_sum']] as const)
    ok(`${agg} ${kind} → refused`, (await chart({ category: 'region', values: [{ column: 'amount', aggregation: agg, calc: { kind, along: 'across' } }] })).code === 'calc_not_additive');
  ok('NEGATIVE CONTROL: diff over avg is not adding', (await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'diff', along: 'across' } }] })).ok === true);
  ok('split: values[0] decides', (await chart({ category: 'day', grain: 'month', series: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'running_total', along: 'down' } }] })).code === 'calc_not_additive');
  ok('split: a second measure\'s calc is ignored, as the grid ignores it', (await chart({ category: 'day', grain: 'month', series: 'region', values: [{ column: 'amount', aggregation: 'sum' }, { column: 'amount', aggregation: 'avg', calc: RT }] })).ok === true);
  ok('formula + − → allowed', (await chart({ category: 'region', values: [{ column: 'Profit', aggregation: 'sum', metricId: profit.id, calc: RT }] })).ok === true);
  ok('formula ratio → refused, named', (await chart({ category: 'region', values: [{ column: 'Per unit', aggregation: 'sum', metricId: perUnit.id, calc: RT }] })).error === msg.calcNotAdditive('Per unit', 'a running total'));
  ok('formula with a parameter reads it', (await chart({ category: 'region', values: [{ column: 'Scaled', aggregation: 'sum', metricId: scaled.id, calc: RT }] }, { params: [{ name: 'k', kind: 'number', value: 2 }] })).ok === true);
  ok('a deleted metric: the stored aggregation decides', (await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'sum', metricId: gone.id, calc: RT }] })).ok === true);
  const pv = { rows: [{ column: 'region' }], columns: [], values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'pct_of_total', along: 'down' } }] };
  ok('pivot avg pct_of_total → refused', (await chart({ category: 'region', values: pv.values, pivot: pv })).code === 'calc_not_additive');
  ok('the builder preview refuses it too', (await preview(null, { projectId: pid, datasetId: ds, encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: RT }] }, filters: [] }) as Any).code === 'calc_not_additive');

  // A snapshot (a stock) adds across regions but not across days. These ask the check directly; scripts/test-snapshot.ts pins it end to end.
  const stockRT = (reply: object, category: string, series?: string, along: 'across' | 'down' = 'across') =>
    A.refuseNonAdditiveCalcs(reply as { ok: boolean }, pid, ds, { category, series, values: [{ column: 'qty', aggregation: 'sum', metricId: stock.id, calc: { kind: 'running_total', along } }] }) as Promise<Any>;
  const okReply = { ok: true, category: { kind: 'text' } };
  ok('snapshot across regions → the reply itself', Object.is(await stockRT(okReply, 'region'), okReply));
  ok('snapshot along a date axis → the over-time sentence', (await stockRT({ ok: true, category: { kind: 'date' } }, 'day')).error === msg.calcNotAdditiveOverTime('Stock', 'a running total'));
  ok('snapshot down a date split → the over-time sentence', (await stockRT(okReply, 'region', 'day', 'down')).error === msg.calcNotAdditiveOverTime('Stock', 'a running total'));
  ok('NEGATIVE CONTROL: snapshot down a text split → the reply itself', Object.is(await stockRT(okReply, 'day', 'region', 'down'), okReply));
  ok('NEGATIVE CONTROL: a map plots no calc, so nothing is refused', Object.is(await A.refuseNonAdditiveCalcs(okReply, pid, ds, { category: 'region', geo: { level: 'us_state' }, values: [{ column: 'amount', aggregation: 'avg', calc: RT }] }), okReply));
  ok('NEGATIVE CONTROL: a reply that is not ok comes back as it is', Object.is(await A.refuseNonAdditiveCalcs(avgRT, pid, ds, { category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: RT }] }), avgRT));

  const plainReply = { ok: true, data: { labels: [], series: [] } };
  let reads = 0; // every read the check makes
  let metaReads = 0; // the dataset-metadata ones among them
  spyOn(metrics, 'getMetric', () => reads++);
  spyOn(datasets, 'getDatasetMeta', () => { reads++; metaReads++; });
  ok('no adding calc: the reply itself, nothing read', Object.is(await A.refuseNonAdditiveCalcs(plainReply, pid, ds, { category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'rank_dense', along: 'across' } }] }), plainReply) && reads === 0);
  // The spies count: a ratio metric's running total must read its record and the dataset's columns.
  await A.refuseNonAdditiveCalcs(okReply, pid, ds, { category: 'region', values: [{ column: 'Per unit', aggregation: 'sum', metricId: perUnit.id, calc: RT }] });
  ok('the spies count: a metric record and the dataset columns', reads - metaReads > 0 && metaReads > 0, `${reads} reads, ${metaReads} of them metadata`);
  // A measure that adds alike on both sides does not need the split column's declared type.
  const metaBefore = metaReads;
  const avgDown = await A.refuseNonAdditiveCalcs(okReply, pid, ds, { category: 'region', series: 'day', values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'running_total', along: 'down' } }] }) as Any;
  ok('a down split of an avg: refused without reading the split column', avgDown.code === 'calc_not_additive' && metaReads === metaBefore, `${metaReads - metaBefore} reads`);

  // ── published ───────────────────────────────────────────────────────────────────────────────────────────────────
  const save = (name: string, encoding: object) => visuals.saveVisual(pid, { datasetId: ds, name, chartType: 'column', encoding } as never);
  const avgVisual = (await save('Avg amount', { category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: RT }] }))!;
  const sumVisual = (await save('Sum amount', { category: 'region', values: [{ column: 'amount', aggregation: 'sum', calc: RT }] }))!;
  const dash = (await analysisStore.saveAnalysis(pid, {
    name: 'Sales overview',
    sheets: [{ id: randomUUID(), name: 'Main', cards: [avgVisual, sumVisual].map((v, i) => ({ id: randomUUID(), type: 'visual', visualId: v.id, layout: { x: 6 * i, y: 0, w: 6, h: 4 } })) }],
  } as never))!;
  const built = await buildDashboard(pid, dash.id, 1);
  const [avgCard, sumCard] = built?.sheets[0].cards ?? [];
  const payload = (c: Any) => c.payloads[c.variants[0]] as Any;
  ok('/p/: the avg tile is built as the sentence', !!avgCard && show(payload(avgCard)) === show({ error: msg.calcNotAdditive('avg of amount', 'a running total') }), show(avgCard && payload(avgCard)));
  ok('NEGATIVE CONTROL: /p/ builds the sum tile', !!sumCard && sumCard.kind === 'chart' && payload(sumCard).error === undefined, show(sumCard && payload(sumCard)));
  const story = (await stories.saveStory(pid, { name: 'Story', blocks: [avgVisual, sumVisual].map((v) => ({ id: randomUUID(), kind: 'visual', visualId: v.id, filters: [] })) }))!;
  const told = await buildStory(pid, story.id);
  ok('a story: the avg block is broken with the sentence', told?.blocks[0].kind === 'broken' && told.blocks[0].reason === msg.calcNotAdditive('avg of amount', 'a running total'), show(told?.blocks[0]));
  ok('NEGATIVE CONTROL: a story keeps the sum block', told?.blocks[1].kind === 'chart', show(told?.blocks[1]));

  // ── assistant ───────────────────────────────────────────────────────────────────────────────────────────────────
  const factsOf = (id: string) => ipcCopilot.buildFacts(pid, { kind: 'visual', id });
  const raws = (f: { ledger: Array<{ label: string }> }) => f.ledger.some((e) => e.label.includes('before the calculation'));
  const refusedFacts = await factsOf(avgVisual.id);
  ok('the Assistant never reads a refused calculation', !refusedFacts.text.includes('before that calculation') && !raws(refusedFacts), refusedFacts.text);
  const allowedFacts = await factsOf(sumVisual.id);
  ok('NEGATIVE CONTROL: it reads an allowed one beside its raw figures', allowedFacts.text.includes('before that calculation') && raws(allowedFacts), allowedFacts.text);

  // ── overlay ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const FEB_2024 = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-02-01', to: '2024-02-29' } }];
  const by = (aggregation: string) => chart({ category: 'day', grain: 'month', overlay: 'previous_year', values: [{ column: 'amount', aggregation }] }, { filters: FEB_2024 });
  const avg = await by('avg');
  ok('avg: the year-earlier series is drawn', avg.ok && avg.data.series.some((s: Any) => s.role === 'overlay'), show(avg));
  ok('avg: no "up N% vs last year" caption', avg.ok && avg.overlay?.kind === 'previous_year' && avg.overlay.caption === undefined && avg.overlay.pct === undefined, show(avg.overlay));
  const sum = await by('sum');
  const captioned = (r: Any) => r.ok && typeof r.overlay?.caption === 'string' && typeof r.overlay?.pct === 'number';
  ok('NEGATIVE CONTROL: sum keeps its caption', captioned(sum), show(sum.overlay));

  // The same gate on the other two ways in: a dashboard's Compare "vs last year" on a dated axis, and the builder's preview.
  const avgCompare = await chart({ category: 'day', grain: 'month', compare: { mode: 'previous_year' }, values: [{ column: 'amount', aggregation: 'avg' }] }, { filters: FEB_2024 });
  ok('avg compare: drawn, no caption', avgCompare.ok && avgCompare.data.series.some((s: Any) => s.role === 'overlay') && avgCompare.overlay?.kind === 'previous_year' && avgCompare.overlay.caption === undefined, show(avgCompare.overlay));
  const sumCompare = await chart({ category: 'day', grain: 'month', compare: { mode: 'previous_year' }, values: [{ column: 'amount', aggregation: 'sum' }] }, { filters: FEB_2024 });
  ok('NEGATIVE CONTROL: sum compare keeps its caption', captioned(sumCompare), show(sumCompare.overlay));
  const previewOf = (aggregation: string) => preview(null, { projectId: pid, datasetId: ds, encoding: { category: 'day', grain: 'month', overlay: 'previous_year', values: [{ column: 'amount', aggregation }] }, filters: FEB_2024 }) as Promise<Any>;
  const avgPreview = await previewOf('avg');
  ok('avg preview: drawn, no caption', avgPreview.ok && avgPreview.data.series.some((s: Any) => s.role === 'overlay') && avgPreview.overlay?.kind === 'previous_year' && avgPreview.overlay.caption === undefined, show(avgPreview.overlay));
  ok('NEGATIVE CONTROL: sum preview keeps its caption', captioned(await previewOf('sum')));

  // A formula over a dashboard parameter adds, but only when the parameter is known: the check gets the same values the chart does.
  const withK = { filters: FEB_2024, params: [{ name: 'k', kind: 'number', value: 2 }] };
  const scaledEnc = { category: 'day', grain: 'month', values: [{ column: 'Scaled', aggregation: 'sum', metricId: scaled.id }] };
  ok('a parameter formula keeps its caption (overlay)', captioned(await chart({ ...scaledEnc, overlay: 'previous_year' }, withK)));
  ok('a parameter formula keeps its caption (compare)', captioned(await chart({ ...scaledEnc, compare: { mode: 'previous_year' } }, withK)));
  ok('a parameter formula keeps its caption (preview)', captioned(await preview(null, { projectId: pid, datasetId: ds, encoding: { ...scaledEnc, overlay: 'previous_year' }, ...withK })));

  // ── facts ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const lines: string[] = []; copilotFacts.metricLines(lines, [], [{ name: 'Avg basket', definitionText: 'avg of amount', value: 3, display: '3', additivity: { categories: false, time: false } }]);
  ok('facts say an average cannot be added up', lines.some((l) => l.includes("Can't be added up across groups or over time.")), lines.join('\n'));
  const plain: string[] = []; copilotFacts.metricLines(plain, [], [{ name: 'Revenue', definitionText: 'sum of revenue', value: 3, display: '3', additivity: { categories: true, time: true } }]);
  ok('NEGATIVE CONTROL: an additive metric gets no extra sentence', !plain.some((l) => l.includes('added up')), plain.join('\n'));
  const said = (a: Additivity | undefined, described = false): string => {
    const out: string[] = [];
    copilotFacts.metricLines(out, [], [{ name: 'M', definitionText: 'd', value: 3, display: '3', additivity: a, description: described ? 'Means it.' : undefined }]);
    return out.join('\n');
  };
  ok('facts: a stock cannot be added up over time only', said({ categories: true, time: false }).includes(" Can't be added up over time."));
  ok('facts: a measure that adds over time but not across groups says so', said({ categories: false, time: true }).includes(" Can't be added up across groups."));
  ok('NEGATIVE CONTROL: unknown additivity gets no sentence', !said(undefined).includes('added up'));
  ok('facts: the sentence comes before the description, which keeps its own ending', said({ categories: false, time: false }, true).endsWith(" Can't be added up across groups or over time. Means: Means it."), said({ categories: false, time: false }, true));

  await metric('Avg basket', { column: 'amount', aggregation: 'avg' });
  const twice = await metric('Twice', { formula: '[Scaled] * 2' });
  const ratioK = await metric('Ratio k', { formula: '[Revenue] / [Cost] * [[k]]' });
  const rows = await automation.metricsList({ projectId: pid } as never) as Array<{ name: string; adds_up: unknown }>;
  const addsUp = (name: string) => rows.find((r) => r.name === name)?.adds_up;
  ok('list_metrics carries adds_up', JSON.stringify(addsUp('Avg basket')) === JSON.stringify({ categories: false, time: false }), show(rows));
  const byNames = await metrics.metricsByName(pid);
  const meta = (await datasets.getDatasetMeta(pid, ds))!;
  for (const m of [profit, perUnit, stock]) {
    const want = A.additivityOf((await metrics.getMetric(pid, m.id))!, meta.columns, byNames);
    ok(`list_metrics: ${m.name} is the rule's own answer`, same(addsUp(m.name) as Additivity, want.categories, want.time), show(addsUp(m.name)));
  }
  ok('list_metrics: a sum adds up across groups and over time', same(addsUp('Revenue') as Additivity, true, true));
  ok('list_metrics: a stock adds across groups, not over time', same(addsUp('Stock') as Additivity, true, false));
  ok('list_metrics: a formula with a parameter is unknown, not "no"', addsUp('Scaled') === null && addsUp('Ratio k') === null);
  ok('list_metrics: a formula that follows one is unknown too', addsUp('Twice') === null);
  const k2 = paramValues([{ name: 'k', kind: 'number', value: 2 }]);
  ok('NEGATIVE CONTROL: with the value known the parameter formulas read', same((await A.metricAdditivity(pid, scaled.id, byNames, k2))!, true, true) && same((await A.metricAdditivity(pid, ratioK.id, byNames, k2))!, false, false));
  ok('NEGATIVE CONTROL: with the value known the formula that follows one reads too', same((await A.metricAdditivity(pid, twice.id, byNames, k2))!, true, true));
  ok('the formula that follows one is unknown while the value is not', (await A.metricAdditivity(pid, twice.id, byNames)) === null);
  const empty = (kind: string, value: unknown) => A.metricAdditivity(pid, scaled.id, byNames, paramValues([{ name: 'k', kind, value }]));
  ok('a parameter defined but empty is unknown, not "no"', (await empty('number', null)) === null && (await empty('list', ['a', 'b'])) === null && (await A.metricAdditivity(pid, twice.id, byNames, paramValues([{ name: 'k', kind: 'number', value: null }]))) === null);
  ok('a parameter the dashboard does not define stays unknown', (await A.metricAdditivity(pid, scaled.id, byNames, paramValues([{ name: 'other', kind: 'number', value: 2 }]))) === null);
  ok('a metric that is gone is unknown', (await A.metricAdditivity(pid, gone.id, byNames)) === null);

  // ── metric:table ─────────────────────────────────────────────────────────────────────────────────────────────────
  const t = await handlers.get('metric:table')!(null, { projectId: pid });
  const revenue = (await metrics.listMetrics(pid)).find((m) => m.name === 'Revenue')!;
  for (const m of [revenue, profit, perUnit, stock]) {
    const want = A.additivityOf((await metrics.getMetric(pid, m.id))!, meta.columns, byNames);
    ok(`metric:table: ${m.name} is the rule's own answer`, same(t.rows[m.id]?.additivity, want.categories, want.time), show(t.rows[m.id]?.additivity));
  }
  ok('metric:table: a ratio cannot be added up', t.rows[perUnit.id].additivity.categories === false);
  ok('metric:table: a formula with a parameter is unknown, not "no"', t.rows[scaled.id].additivity === null);
  ok('NEGATIVE CONTROL: metric:table: a sum adds up across time', t.rows[revenue.id].additivity.time === true);

  // The Assistant's own facts block, from a dataset (no parameters known) and from a dashboard (its saved parameters).
  const onDataset = (await ipcCopilot.buildFacts(pid, { kind: 'dataset', id: ds })).text;
  const lineOf = (text: string, name: string) => text.split('\n').find((l) => l.startsWith(`- "${name}"`)) ?? '';
  ok('the dataset facts: an average is marked', lineOf(onDataset, 'Avg basket').includes("Can't be added up across groups or over time."), lineOf(onDataset, 'Avg basket'));
  ok('the dataset facts: a stock is marked over time only', lineOf(onDataset, 'Stock').includes("Can't be added up over time.") && !lineOf(onDataset, 'Stock').includes('across groups'), lineOf(onDataset, 'Stock'));
  ok('NEGATIVE CONTROL: the dataset facts leave a sum and an unknown unmarked', lineOf(onDataset, 'Revenue') !== '' && !lineOf(onDataset, 'Revenue').includes('added up') && lineOf(onDataset, 'Ratio k') !== '' && !lineOf(onDataset, 'Ratio k').includes('added up'), lineOf(onDataset, 'Ratio k'));
  const withK2 = (await analysisStore.saveAnalysis(pid, { name: 'With k', sheets: [{ id: randomUUID(), name: 'Main', cards: [] }], parameters: [{ name: 'k', kind: 'number', value: 2 }] } as never))!;
  const onDashboard = (await ipcCopilot.buildFacts(pid, { kind: 'analysis', id: withK2.id })).text;
  const saved = savedScope(withK2).params;
  ok('the dashboard facts: a parameter formula is read with its saved values', lineOf(onDashboard, 'Ratio k').includes("Can't be added up") && lineOf(onDashboard, 'Scaled') !== '' && !lineOf(onDashboard, 'Scaled').includes('added up'), lineOf(onDashboard, 'Ratio k'));
  ok('the dashboard\'s saved values make the unmarked formula a known additive one, not an unknown', same((await A.metricAdditivity(pid, scaled.id, byNames, saved))!, true, true) && same((await A.metricAdditivity(pid, ratioK.id, byNames, saved))!, false, false));

  // ── countd (part 5, D3): a distinct count adds across neither, so no calculation and no caption adds it up ───────
  const CD = { column: 'region', aggregation: 'countd' };
  const regions = await metric('Regions', CD);
  ok('a countd metric adds across neither', same(A.additivityOf((await metrics.getMetric(pid, regions.id))!, meta.columns, await metrics.metricsByName(pid)), false, false));
  ok('running total over countd → refused', (await chart({ category: 'day', grain: 'month', values: [{ ...CD, calc: RT }] })).code === 'calc_not_additive');
  ok('share of total over countd → refused', (await chart({ category: 'region', values: [{ ...CD, calc: { kind: 'pct_of_total', along: 'across' } }] })).code === 'calc_not_additive');
  ok('moving sum over a countd metric → refused, named', (await chart({ category: 'day', grain: 'month', values: [{ ...CD, metricId: regions.id, calc: { kind: 'moving_sum', along: 'across', window: 3 } }] })).error === msg.calcNotAdditive('Regions', 'a moving sum'));
  ok('NEGATIVE CONTROL: the same running total over count runs', (await chart({ category: 'day', grain: 'month', values: [{ column: 'region', aggregation: 'count', calc: RT }] })).ok === true);
  ok('a diff over countd is not adding', (await chart({ category: 'region', values: [{ ...CD, calc: { kind: 'diff', along: 'across' } }] })).ok === true);
  const overCd = await chart({ category: 'day', grain: 'month', overlay: 'previous_year', values: [CD] }, { filters: FEB_2024 });
  ok('overlay over countd: the series, no caption', overCd.ok && overCd.data.series.some((x: Any) => x.role === 'overlay') && overCd.overlay?.caption === undefined && overCd.overlay?.pct === undefined, show(overCd));
  ok('NEGATIVE CONTROL: the same overlay over count keeps its caption', captioned(await chart({ category: 'day', grain: 'month', overlay: 'previous_year', values: [{ column: 'region', aggregation: 'count' }] }, { filters: FEB_2024 })));

  // ── chart shapes: a waterfall's running level, a Pareto's cumulative share and a 100% stack's shares add the measure up ──
  const SHAPES = [['waterfall', 'a waterfall'], ['pareto', 'a Pareto chart'], ['pct_stacked_column', 'a 100% stacked chart'], ['pct_stacked_bar', 'a 100% stacked chart']] as const;
  for (const [chartType, what] of SHAPES) {
    for (const [agg, col] of [['avg', 'amount'], ['countd', 'region'], ['min', 'amount'], ['max', 'amount']] as const) {
      const r = await chart({ category: 'region', values: [{ column: col, aggregation: agg }] }, { chartType });
      ok(`${agg} as ${chartType} → refused with its sentence`, r.ok === false && r.code === 'calc_not_additive' && r.error === msg.calcNotAdditive(`${aggWord(agg)} of ${col}`, what), show(r));
    }
    const sum = await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, { chartType });
    ok(`NEGATIVE CONTROL: sum as ${chartType} draws, with its figures`, sum.ok === true && !!sum.data.figures, show(sum).slice(0, 300));
    ok(`NEGATIVE CONTROL: count as ${chartType} draws`, (await chart({ category: 'region', values: [{ column: 'region', aggregation: 'count' }] }, { chartType })).ok === true);
  }
  ok('a split 100% stack of a countd metric → refused, named', (await chart({ category: 'day', grain: 'month', series: 'region', values: [{ ...CD, metricId: regions.id }] }, { chartType: 'pct_stacked_column' })).error === msg.calcNotAdditive('Regions', 'a 100% stacked chart'));
  ok('a waterfall of a snapshot by month → the over-time sentence', (await chart({ category: 'day', grain: 'month', values: [{ column: 'qty', aggregation: 'sum', metricId: stock.id }] }, { chartType: 'waterfall' })).error === msg.calcNotAdditiveOverTime('Stock', 'a waterfall'));
  ok('NEGATIVE CONTROL: …by region it adds, and draws', (await chart({ category: 'region', values: [{ column: 'qty', aggregation: 'sum', metricId: stock.id }] }, { chartType: 'waterfall' })).ok === true);
  ok('NEGATIVE CONTROL: a waterfall draws its first series only, so a second avg is not judged', (await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'sum' }, { column: 'amount', aggregation: 'avg' }] }, { chartType: 'waterfall' })).ok === true);
  ok('NEGATIVE CONTROL: avg as a plain column draws', (await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'avg' }] }, { chartType: 'column' })).ok === true);
  const pareto = (await visuals.saveVisual(pid, { datasetId: ds, name: 'Avg Pareto', chartType: 'pareto', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'avg' }] } } as never))!;
  const shapeDash = (await analysisStore.saveAnalysis(pid, { name: 'Shapes', sheets: [{ id: randomUUID(), name: 'Main', cards: [{ id: randomUUID(), type: 'visual', visualId: pareto.id, layout: { x: 0, y: 0, w: 6, h: 4 } }] }] } as never))!;
  const shapeCard = (await buildDashboard(pid, shapeDash.id, 1))?.sheets[0].cards[0];
  ok('/p/: an avg Pareto tile is built as the sentence', !!shapeCard && payload(shapeCard).error === msg.calcNotAdditive('avg of amount', 'a Pareto chart'), show(shapeCard && payload(shapeCard)));
  const card = await answers.computeCard(pid, { datasetId: ds, category: 'region', measures: [{ column: 'amount', aggregation: 'avg' }], filters: [], chartType: 'waterfall', title: 'x' } as never);
  ok('an answer card drawn as an avg waterfall → refused with the sentence', 'reason' in card && card.reason === msg.calcNotAdditive('avg of amount', 'a waterfall'), show(card).slice(0, 300));
  ok('NEGATIVE CONTROL: …as a sum it draws', 'card' in (await answers.computeCard(pid, { datasetId: ds, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'waterfall', title: 'x' } as never)));
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
