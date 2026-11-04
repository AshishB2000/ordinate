// The additivity rule (semantic layer part 1, D7): whether a measure can be added up across categories and
// across time, derived from what the measure IS and never typed in. A running total, a percent of total and a
// moving sum add; a chart that asks one of them of a measure that does not add is refused with a sentence.
//
//   rules       the pure rule and its sentences
//   doors       visual:data and visual:preview refuse the calc, with the measure named; an adding measure still runs
//   published   /p/ builds the tile as an error, and a story block as a broken block
//   assistant   the Assistant reads the raw figures of a refused chart
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
const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const { buildDashboard }: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const { buildStory }: typeof import('../src/publish/storyData') = require('../src/publish/storyData');
type Additivity = import('../src/analysis/additivity').Additivity;
type Metric = import('../src/analysis/metrics').Metric;
type Any = any; // any: each handler's own reply shape, read field by field below

const DS = 'ds-1';

// ── rules ────────────────────────────────────────────────────────────────────────────────────────────────────────
const same = (a: Additivity, c: boolean, t: boolean) => Object.is(a.categories, c) && Object.is(a.time, t);
for (const [agg, want] of [['sum', true], ['count', true], ['none', true], ['avg', false], ['min', false], ['max', false]] as const)
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

  // A snapshot (a stock) adds across regions but not across days. The chart door cannot draw a snapshot metric yet (step 07), so these ask the check directly.
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
  let reads = 0;
  spyOn(metrics, 'getMetric', () => reads++);
  spyOn(datasets, 'getDatasetMeta', () => reads++);
  ok('no adding calc: the reply itself, nothing read', Object.is(await A.refuseNonAdditiveCalcs(plainReply, pid, ds, { category: 'region', values: [{ column: 'amount', aggregation: 'avg', calc: { kind: 'rank_dense', along: 'across' } }] }), plainReply) && reads === 0);

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
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
