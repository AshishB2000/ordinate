// A metric's target on its charts and in its alerts (semantic layer part 5, step 10): the stepped target series the
// server adds to a chart, and the alert that fires on a share of the target.
//
//   charts   a target per bucket on the metric's own date axis (the tile's figure for that bucket), per category through
//            the plan's column of the same name, and no series (with a note) where it can't be drawn
//   quiet    NEGATIVE CONTROLS: a chart with no metric measure is the reply itself and nothing is read; two measures,
//            a split and a running total draw no target; a metric with no target adds nothing
//
//   npm run build:ts && node scripts/test-targetCharts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';
import type { FilterStep } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';
import type { Metric } from '../src/analysis/metrics';

const { createHash }: typeof import('crypto') = require('crypto');
const tm: typeof import('../src/analysis/targetMessages') = require('../src/analysis/targetMessages');
const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const targetResolve: typeof import('../src/ipc/targetResolve') = require('../src/ipc/targetResolve');
const overlay: typeof import('../src/ipc/visualsOverlay') = require('../src/ipc/visualsOverlay');
const tableCalc: typeof import('../src/analysis/tableCalc') = require('../src/analysis/tableCalc');
const driverScope: typeof import('../src/analysis/driverScope') = require('../src/analysis/driverScope');
const visualsMod: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');

const PLAIN_PIN = 'f0af71e7c3b1cc3ea706ba82a9c6e00ba12e7dbaed26999b6b2797489abf7c2b';
const SALES_COLS: ParsedColumn[] = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'channel', type: 'text' }, { name: 'amount', type: 'number' }];
const PLAN_COLS: ParsedColumn[] = [{ name: 'month', type: 'date' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }];
const step = (column: string, op: string, value: string): FilterStep => ({ type: 'filter', column, op, value } as FilterStep);
const on = (from: string, to: string, column = 'day'): FilterStep[] => [step(column, '>=', from), step(column, '<=', to)];
const show = (v: unknown): string => (JSON.stringify(v) ?? 'undefined').slice(0, 500);

/** Sales: two 100 sales in each of Jan–Apr, then 100 a day for November 1–20 (today). Plan: 1M a month Jan–Apr, Nov 600k per region. */
async function fixtures() {
  const P = (await H.setupOrg(H.ORG_A)).projectId;
  const days: (string | number)[][] = [];
  for (const mo of ['01', '02', '03', '04']) for (const d of ['14', '15']) days.push([`2024-${mo}-${d}`, 'East', 'web', 100]);
  for (let d = 1; d <= 20; d++) days.push([`2024-11-${String(d).padStart(2, '0')}`, d % 2 ? 'West' : 'East', 'web', 100]);
  const planRows: (string | number)[][] = [['2024-11-01', 'East', 600_000], ['2024-11-01', 'West', 600_000], ['2024-12-01', 'East', 700_000]];
  for (const mo of ['01', '02', '03', '04']) planRows.push([`2024-${mo}-01`, 'East', 1_000_000]);
  const D = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Sales', sourceKind: 'csv', columns: SALES_COLS, rows: days } as never)))!.id;
  const PD = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Plan', sourceKind: 'csv', columns: PLAN_COLS, rows: planRows } as never)))!.id;
  process.env.ORDINATE_TODAY = '2024-11-20';
  const saved = async (input: Record<string, unknown>): Promise<Metric> => {
    const r = (await post('metric:save', { projectId: P, input })).value;
    if (r.ok !== true) throw new Error(`save ${String(input.name)}: ${show(r)}`);
    return r.metric as Metric;
  };
  const planRev = await saved({ name: 'Plan revenue', datasetId: PD, definition: { column: 'amount', aggregation: 'sum' }, timeColumn: 'month' });
  const rev = await saved({ name: 'Revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, timeColumn: 'day', target: { source: { metricId: planRev.id }, per: 'month' } });
  const units = await saved({ name: 'Units', datasetId: D, definition: { column: 'amount', aggregation: 'count' }, timeColumn: 'day' });
  return { P, D, PD, rev, units, planRev, saved };
}

async function chartsSection(): Promise<void> {
  const { P, D, rev, units } = await fixtures();
  const M = (m: Metric): Record<string, unknown> => ({ column: 'amount', aggregation: m.definition && (m.definition as { aggregation: string }).aggregation, metricId: m.id });
  const chart = async (encoding: Record<string, unknown>, filters: FilterStep[]): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId: D, encoding, filters })).value;
  const targetOf = (r: Reply): Reply | undefined => r.data?.series?.find((s: Reply) => s.target);
  const at = (r: Reply, label: string): number | null => targetOf(r)?.values[r.data.labels.indexOf(label)];
  const Y2024 = on('2024-01-01', '2024-12-31');
  const THIS_MONTH = on('2024-11-01', '2024-11-30');
  const tile = (label: string): Promise<number | null> => {
    const r = driverScope.bucketRange(label, 'month')!;
    return H.as(H.ORG_A, async () => (await targetResolve.metricTarget(P, (await metricsMod.getMetric(P, rev.id))!, on(r.from!, r.to!), null))?.value ?? null);
  };

  const byMonth = await chart({ category: 'day', grain: 'month', values: [M(rev)] }, Y2024);
  const tgt = targetOf(byMonth);
  ok('a stepped target series per month, marked as one', !!tgt && tgt.role === 'overlay' && tgt.target === true && tgt.name === 'Target', show(byMonth.data?.series));
  let same = !!tgt && byMonth.data.labels.length === 5;
  for (const [i, l] of (byMonth.data?.labels ?? []).entries()) same = same && Object.is(tgt?.values[i], await tile(String(l)));
  ok('…each label the tile\'s own target for that month', same, show(tgt));
  ok('November is pro-rated to today (20 of 30 days)', Object.is(at(byMonth, '2024-11'), 1_200_000 * 20 / 30), String(at(byMonth, '2024-11')));
  ok('a whole month is the whole plan', Object.is(at(byMonth, '2024-01'), 1_000_000));
  ok('the actuals series is untouched and first', byMonth.data.series[0].name !== 'Target' && !byMonth.data.series[0].target);

  const byRegion = await chart({ category: 'region', values: [M(rev)] }, THIS_MONTH);
  ok('by region: the plan\'s region column, pro-rated', Object.is(at(byRegion, 'East'), 600_000 * 20 / 30) && Object.is(at(byRegion, 'West'), 600_000 * 20 / 30), show(targetOf(byRegion)));
  const span = await chart({ category: 'region', values: [M(rev)] }, on('2024-01-15', '2024-04-10'));
  ok('a span by region: partial Jan + whole Feb–Mar + partial Apr, three resolutions combined', Math.abs((at(span, 'East') ?? NaN) - (1_000_000 * 17 / 31 + 2_000_000 + 1_000_000 * 10 / 30)) < 1e-6, show(targetOf(span)));
  const byChannel = await chart({ category: 'channel', values: [M(rev)] }, THIS_MONTH);
  ok('by channel: no series, and why', !targetOf(byChannel) && !!byChannel.notes?.includes(tm.targetPlanNoColumn('channel')), show(byChannel.notes));
  const twenty5 = await chart({ category: 'day', grain: 'day', values: [M(rev)] }, Y2024);
  ok('more than 24 dates: no series, and why', !targetOf(twenty5) && !!twenty5.notes?.includes(tm.targetSeriesTooLong()), show(twenty5.notes));

  ok('two measures: no target series', !targetOf(await chart({ category: 'region', values: [M(rev), M(units)] }, THIS_MONTH)));
  ok('a split chart: no target series', !targetOf(await chart({ category: 'day', grain: 'month', series: 'region', values: [M(rev)] }, Y2024)));
  const plainChart = await chart({ category: 'region', values: [M(units)] }, THIS_MONTH);
  ok('a metric with no target: no series, no note', !targetOf(plainChart) && !('notes' in plainChart), show(plainChart.notes));
  const rawChart = await chart({ category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, THIS_MONTH);
  ok('a measure that is no metric: no series', !targetOf(rawChart) && rawChart.data.series.length === 1);

  // A target series never feeds a total: every reader of a chart skips the overlay role.
  const calc = tableCalc.withTableCalcs({ ok: true, data: { labels: ['a', 'b'], series: [{ name: 'Revenue', values: [1, 2] }, { name: 'Target', values: [10, 20], role: 'overlay', target: true }] } } as never, { category: 'x', values: [{ column: 'amount', aggregation: 'sum', calc: { kind: 'running_total', along: 'across' } }] } as never) as Reply;
  ok('a running total ignores the target series', JSON.stringify(calc.data.series[1].values) === '[10,20]' || calc.data.series[1].values.every((v: number, i: number) => v === [10, 20][i]), show(calc.data.series));
  const vis = await H.as(H.ORG_A, () => visualsMod.saveVisual(P, { name: 'Revenue by region', datasetId: D, chartType: 'bar', encoding: { category: 'region', values: [M(rev)] } }));
  const facts = await H.as(H.ORG_A, () => ipcCopilot.buildFacts(P, { kind: 'visual', id: vis!.id } as never));
  ok('the Assistant\'s facts never read it', !facts.text.includes('Target'), facts.text.slice(0, 300));

  // Old content first: charts of a metric with no target, of a raw measure, and by date, reply byte for byte as before (hash taken before this step's code).
  const olds = [plainChart, rawChart, await chart({ category: 'day', grain: 'month', values: [M(units)] }, Y2024), await chart({ category: 'day', grain: 'month', values: [{ column: 'amount', aggregation: 'sum' }] }, Y2024)];
  const pin = createHash('sha256').update(JSON.stringify(olds.map(({ asOf: _a, ...r }) => r))).digest('hex');
  if (process.env.PRINT_PIN) console.log(pin);
  ok('NEGATIVE CONTROL: charts with no metric target reply byte-identically to before', pin === PLAIN_PIN, pin);

  let reads = 0;
  const realGet = metricsMod.getMetric;
  (metricsMod as unknown as { getMetric: unknown }).getMetric = (...a: Parameters<typeof realGet>) => { reads++; return realGet(...a); };
  const PLAIN_REPLY = { ok: true, data: { labels: ['a'], series: [{ name: 's', values: [1] }] }, warnings: [] } as never;
  const out = await overlay.withTargetSeries(PLAIN_REPLY, P, D, { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } as never, []);
  (metricsMod as unknown as { getMetric: unknown }).getMetric = realGet;
  ok('NEGATIVE CONTROL: a chart with no metric measure is the reply itself, and nothing was read', Object.is(out, PLAIN_REPLY) && reads === 0, String(reads));
}

async function main(): Promise<void> {
  await chartsSection();
  await close();
  finish();
}

void main();
