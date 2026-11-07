// A metric's target on its charts and in its alerts (semantic layer part 5, step 10): the stepped target series the
// server adds to a chart, and the alert that fires on a share of the target.
//
//   charts   a target per bucket on the metric's own date axis (the tile's figure for that bucket), per category through
//            the plan's column of the same name, and no series (with a note) where it can't be drawn
//   quiet    NEGATIVE CONTROLS: a chart with no metric measure is the reply itself and nothing is read; two measures,
//            a split and a running total draw no target; a metric with no target adds nothing
//   share    under drop an export-shaped chart carries no target series when the plan's column is marked, as a chart of
//            the plan itself is hidden; NEGATIVE CONTROLS: in the app, under mask (figures pass on any table), and with
//            the plan's column unmarked, the export keeps the target series
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
const alerts: typeof import('../src/analysis/alerts') = require('../src/analysis/alerts');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const { randomUUID }: typeof import('crypto') = require('crypto');
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

async function alertsSection(): Promise<void> {
  const { P, D, rev, units } = await fixtures();
  const THIS_MONTH = on('2024-11-01', '2024-11-30');
  const NOW = Date.parse('2024-11-20T12:00:00Z');
  const rule = { id: randomUUID(), name: 'Revenue off plan', datasetId: D, enabled: true, compare: 'target', targetPct: { op: 'below', pct: 90 }, metric: { column: '', aggregation: 'sum', metricId: rev.id, filters: THIS_MONTH } };
  const stored = async () => (await H.as(H.ORG_A, () => alertStore.load(P))).rules.find((r) => r.id === rule.id)!;
  const evaluate = (now: number) => H.as(H.ORG_A, () => alertStore.evaluateProject(P, D, now));

  // The pure decision.
  const R = alerts.sanitizeRule(rule)!;
  ok('below 90% of 800: 700 is a breach, 720 is not', alerts.targetBreached(R, 700, 800) && !alerts.targetBreached(R, 720, 800));
  ok('above 110% of 800: 900 is a breach', alerts.targetBreached({ ...R, targetPct: { op: 'above', pct: 110 } }, 900, 800) && !alerts.targetBreached({ ...R, targetPct: { op: 'above', pct: 110 } }, 880, 800));
  ok('NEGATIVE CONTROL: no target and no value are never a breach', !alerts.targetBreached(R, 700, null) && !alerts.targetBreached(R, null, 800));
  ok('NEGATIVE CONTROL: a threshold rule is never a target breach', !alerts.targetBreached({ ...R, compare: 'threshold' }, 1, 800));

  await H.as(H.ORG_A, () => alertStore.restoreRule(P, rule));
  const fired = await evaluate(NOW);
  const want = 800_000;
  ok('below 90% of target: fires once, with the share and the target in the sentence', fired.length === 1 && fired[0].message === alerts.alertMessage(R, fired[0].value, null, 0, want), show(fired));
  ok('…the sentence names both figures', /% of its target of 800\.0K/.test(fired[0]?.message ?? ''), fired[0]?.message);
  ok('…and not again while still below (the edge)', (await evaluate(NOW + 3_600_000)).length === 0 && (await stored()).armed === true);
  // Raise the sales' share of the target by lowering the target: the rule re-arms on the way out, without firing.
  await post('metric:update', { projectId: P, id: rev.id, patch: { target: { source: { value: 2000 }, per: 'month' } } });
  ok('back above re-arms without firing', (await evaluate(NOW + 7_200_000)).length === 0 && (await stored()).armed === undefined);
  await post('metric:update', { projectId: P, id: rev.id, patch: { target: { source: { value: 90_000 }, per: 'month' } } });
  ok('and below again fires again', (await evaluate(NOW + 10_800_000)).length === 1);

  const probe = { ...rule, id: randomUUID() };
  ok('NEGATIVE CONTROL: no period in scope, no target, never fires', (await H.as(H.ORG_A, () => alertStore.testRule(P, { ...probe, metric: { ...rule.metric, filters: [] } }))).fire === false);
  ok('the Test button says it would fire for the period in scope', (await H.as(H.ORG_A, () => alertStore.testRule(P, probe))).fire === true);
  const plainRule = { ...rule, id: randomUUID(), metric: { ...rule.metric, metricId: units.id } };
  ok('NEGATIVE CONTROL: a metric with no target never fires', (await H.as(H.ORG_A, () => alertStore.testRule(P, plainRule))).fire === false);

  // As "Alert me…" stores it from a KPI card: the card's column and total beside the metric. East is 1,000 of a 2,000 target.
  const east = (await post('metric:save', { projectId: P, input: { name: 'East revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, filters: [step('region', '=', 'East')], timeColumn: 'day', target: { source: { value: 3000 }, per: 'month' } } })).value.metric as Metric;
  const fromCard = { ...rule, id: randomUUID(), metric: { column: 'amount', aggregation: 'sum', metricId: east.id, filters: THIS_MONTH, label: 'East revenue' } };
  const tile = await H.as(H.ORG_A, () => ipcMetrics.resolveMetric(P, east.id, { filters: THIS_MONTH }));
  const watched = await H.as(H.ORG_A, () => alertStore.metricFor(P, fromCard as never));
  ok('a target rule from a KPI card watches the metric, its own filter and all', typeof watched.value === 'number' && Object.is(watched.value, tile?.value) && Object.is(watched.target, 2000), show([watched, tile?.value]));
  ok('… so at 50% of its target it fires', (await H.as(H.ORG_A, () => alertStore.testRule(P, fromCard))).fire === true);
  const copy = await H.as(H.ORG_A, () => alertStore.metricFor(P, { ...fromCard, compare: 'threshold', threshold: { op: '>', value: 0 } } as never));
  ok('NEGATIVE CONTROL: a threshold rule from that card keeps its stored copy', Object.is(copy.value, (await H.as(H.ORG_A, () => ipcMetrics.resolveMetric(P, rev.id, { filters: THIS_MONTH })))?.value) && !Object.is(copy.value, tile?.value), show(copy));

  await post('metric:delete', { projectId: P, id: rev.id });
  const before = JSON.stringify(await stored());
  await evaluate(NOW + 14_400_000);
  ok('a deleted metric: the rule is not evaluated, untouched', JSON.stringify(await stored()) === before);
  const listed = (await post('alerts:list', { projectId: P })).value.rules.find((r: Reply) => r.id === rule.id);
  ok('…and the inbox says its metric is gone', listed?.metricGone === true, show(listed));
  const other = { id: randomUUID(), name: 'Plain', datasetId: D, enabled: true, compare: 'threshold', threshold: { op: '>', value: 0 }, metric: { column: 'amount', aggregation: 'sum', metricId: units.id } };
  await H.as(H.ORG_A, () => alertStore.restoreRule(P, other));
  ok('NEGATIVE CONTROL: a rule whose metric is there carries no metricGone', (await post('alerts:list', { projectId: P })).value.rules.every((r: Reply) => r.id === rule.id || !('metricGone' in r)));
}

async function shareSection(): Promise<void> {
  const { P, D, PD, rev } = await fixtures();
  const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
  const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
  const enc = { category: 'day', grain: 'month', values: [{ column: 'amount', aggregation: 'sum', metricId: rev.id }] };
  const chart = async (share?: string): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId: D, encoding: enc, filters: on('2024-01-01', '2024-12-31'), ...(share ? { share } : {}) })).value;
  const targetOf = (r: Reply): Reply | undefined => r.data?.series?.find((x: Reply) => x.target);
  await H.as(H.ORG_A, () => catalog.setColumn(P, PD, 'amount', { sensitivity: 'financial' }));
  const app = targetOf(await chart());
  ok('NEGATIVE CONTROL: share: in the app the chart keeps its target series', !!app);
  const planChart = async (): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId: PD, encoding: { category: 'month', grain: 'month', values: [{ column: 'amount', aggregation: 'sum' }] }, share: 'export' })).value;
  await H.as(H.ORG_A, () => store.setPolicy(P, { publish: 'drop', export: 'drop' }));
  ok('share, drop, the twin: a chart of the plan itself is hidden', (await planChart()).hiddenByPolicy === true);
  const dropped = await chart('export');
  ok('share, drop: an export-shaped chart carries no target series from a plan over a marked column', dropped.ok === true && !targetOf(dropped) && !JSON.stringify(dropped).includes('1000000'), show(dropped.data?.series));
  await H.as(H.ORG_A, () => store.setPolicy(P, { publish: 'mask', export: 'mask' }));
  ok('NEGATIVE CONTROL: share, mask: figures pass on any table, so the export keeps the app\'s target series', JSON.stringify(targetOf(await chart('export'))) === JSON.stringify(app) && (await planChart()).ok === true);
  await H.as(H.ORG_A, () => store.setPolicy(P, { publish: 'drop', export: 'drop' }));
  await H.as(H.ORG_A, () => catalog.setColumn(P, PD, 'amount', { sensitivity: 'none' }));
  ok('NEGATIVE CONTROL: share: with the plan\'s column unmarked the export keeps it', !!targetOf(await chart('export')));
}

async function main(): Promise<void> {
  await chartsSection();
  await shareSection();
  await alertsSection();
  await close();
  finish();
}

void main();
