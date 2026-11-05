// Targets on a metric (semantic layer part 5, step 09): the period arithmetic (math), the target under a scope
// (resolve) and the surfaces that show it (surfaces).
//
//   npm run build:ts && node scripts/test-targets.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';
import type { FilterStep } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';
import type { Metric } from '../src/analysis/metrics';

const { isDeepStrictEqual } = require('util') as typeof import('util');
const tmath: typeof import('../src/analysis/targetMath') = require('../src/analysis/targetMath');
const model: typeof import('../src/analysis/scorecardModel') = require('../src/analysis/scorecardModel');
const tm: typeof import('../src/analysis/targetMessages') = require('../src/analysis/targetMessages');
const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const metricFormat: typeof import('../src/analysis/metricFormat') = require('../src/analysis/metricFormat');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const targetResolve: typeof import('../src/ipc/targetResolve') = require('../src/ipc/targetResolve');

const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);

function mathSection(): void {
  const G = { weekStart: 1, fiscalYearStart: 1 } as import('../src/analysis/dateIntel').CalendarPrefs;
  const W445 = { ...G, calendarType: '445' } as import('../src/analysis/dateIntel').CalendarPrefs;
  const p = tmath.periodParts({ from: '2026-11-01', to: '2026-11-20' }, 'month', G);
  ok('Nov 1–20 is 20 of 30 days of November', p.length === 1 && p[0].covered === 20 && p[0].days === 30);
  ok('1.2M a month, pro-rated to Nov 20, is 800k', Object.is(tmath.fixedTarget(1_200_000, p), 800_000));
  ok('February 2024 has 29 days', tmath.periodParts({ from: '2024-02-10', to: '2024-02-29' }, 'month', G)[0].days === 29);
  const span = tmath.periodParts({ from: '2024-01-15', to: '2024-04-10' }, 'month', G);
  ok('a span: partial Jan, whole Feb–Mar, partial Apr', span.length === 4 && span[0].covered === 17 && span[3].covered === 10);
  ok('…planned as three asks, the middle as one', same(tmath.planAsks(span), [
    { from: '2024-01-01', to: '2024-01-31', fraction: 17 / 31 },
    { from: '2024-02-01', to: '2024-03-31', fraction: 1 },
    { from: '2024-04-01', to: '2024-04-30', fraction: 10 / 30 },
  ]));
  ok('a whole month is one ask with fraction 1', same(tmath.planAsks(tmath.periodParts({ from: '2024-03-01', to: '2024-03-31' }, 'month', G)), [{ from: '2024-03-01', to: '2024-03-31', fraction: 1 }]));
  ok('a partial month alone is one ask with its share', same(tmath.planAsks(p), [{ from: '2026-11-01', to: '2026-11-30', fraction: 20 / 30 }]));
  // A 4-4-5 year has 28- and 35-day "months": find a 35-day one by walking the calendar, then cover part of it.
  let five: { from: string; to: string } | null = null;
  for (let k = 0; k < 12 && !five; k++) {
    const w = model.periodWindow('2024-09-15', 'month', k, W445);
    if (w && Date.parse(w.to) - Date.parse(w.from) === 34 * 86_400_000) five = w;
  }
  ok('the 4-4-5 calendar has a 35-day month', five !== null);
  const w = tmath.periodParts({ from: five!.from, to: five!.from }, 'month', W445);
  ok('a 4-4-5 period divides by its own 35 days, never 30', w.length === 1 && w[0].days === 35 && w[0].covered === 1 && Object.is(tmath.fixedTarget(350, w), 10));
  ok('fiscal quarters follow the fiscal year', tmath.periodParts({ from: '2024-04-01', to: '2024-04-30' }, 'quarter', { ...G, fiscalYearStart: 4 })[0].days === 91);
  ok('widened to whole periods', same(tmath.widened(span), { from: '2024-01-01', to: '2024-04-30' }));
  ok('NEGATIVE CONTROL: a reversed range has no parts', tmath.periodParts({ from: '2024-05-01', to: '2024-04-01' }, 'month', G).length === 0);
}

const SALES_COLS: ParsedColumn[] = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'channel', type: 'text' }, { name: 'amount', type: 'number' }];
const PLAN_COLS: ParsedColumn[] = [{ name: 'month', type: 'date' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }];
const step = (column: string, op: string, value: string): FilterStep => ({ type: 'filter', column, op, value } as FilterStep);
const on = (from: string, to: string, column = 'day'): FilterStep[] => [step(column, '>=', from), step(column, '<=', to)];
const eqs = (column: string, value: string): FilterStep => step(column, '=', value);
const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);

async function resolveSection(): Promise<void> {
  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;
  const days: (string | number)[][] = [];
  for (let d = 1; d <= 20; d++) days.push([`2024-11-${String(d).padStart(2, '0')}`, d % 2 ? 'West' : 'East', 'web', 100]);
  const planRows: (string | number)[][] = [['2024-11-01', 'East', 600_000], ['2024-11-01', 'West', 600_000], ['2024-12-01', 'East', 700_000]];
  for (const mo of ['01', '02', '03', '04']) planRows.push([`2024-${mo}-01`, 'East', 1_000_000]);
  const D = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Sales', sourceKind: 'csv', columns: SALES_COLS, rows: days } as never)))!.id;
  const PD = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Plan', sourceKind: 'csv', columns: PLAN_COLS, rows: planRows } as never)))!.id;
  await H.as(H.ORG_A, () => H.fx.loadWarehouse('sales', SALES_COLS, days as never));
  const L = (await H.as(H.ORG_A, () => H.liveOver(P, { table: 'sales' }, SALES_COLS))).liveId;
  process.env.ORDINATE_TODAY = '2024-11-20';

  const saved = async (input: Record<string, unknown>): Promise<Metric> => {
    const r = (await post('metric:save', { projectId: P, input })).value;
    if (r.ok !== true) throw new Error(`save ${String(input.name)}: ${show(r)}`);
    return r.metric as Metric;
  };
  const planRev = await saved({ name: 'Plan revenue', datasetId: PD, definition: { column: 'amount', aggregation: 'sum' }, timeColumn: 'month' });
  const REV_TARGET = { source: { metricId: planRev.id }, per: 'month' };
  const rev = await saved({ name: 'Revenue', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, timeColumn: 'day', target: REV_TARGET });
  const avg = await saved({ name: 'Avg sale', datasetId: D, definition: { column: 'amount', aggregation: 'avg' }, timeColumn: 'day', target: { source: { value: 50 } } });
  const revLive = await saved({ name: 'Live revenue', datasetId: L, definition: { column: 'amount', aggregation: 'sum' }, timeColumn: 'day', target: REV_TARGET });
  const plain = await saved({ name: 'Units', datasetId: D, definition: { column: 'amount', aggregation: 'count' }, timeColumn: 'day' });
  const metricOf = async (id: string): Promise<Metric> => (await H.as(H.ORG_A, () => metricsMod.getMetric(P, id)))!;
  const t = async (m: Metric, f: FilterStep[], value: number | null = null) => H.as(H.ORG_A, async () => targetResolve.metricTarget(P, await metricOf(m.id), f, value));
  const fmt = (v: number): string => metricFormat.formatMetricValue(v, rev.format);
  const planNov = 1_200_000, planNovEast = 600_000;
  const THIS_MONTH = on('2024-11-01', '2024-11-30');

  // The default metric has no target: the reply is the old one, byte for byte (no `target` key anywhere).
  ok('a metric with no target has no target result', (await t(plain, THIS_MONTH)) === null);
  ok('NEGATIVE CONTROL: the stored metric carries no target key', !('target' in (await metricOf(plain.id))));
  ok('this month, pro-rated: November\'s plan × 20/30', Object.is((await t(rev, THIS_MONTH))!.value, planNov * (20 / 30)), show(await t(rev, THIS_MONTH)));
  ok('the tile says how', (await t(rev, THIS_MONTH))!.how === tm.targetHowProRated(fmt(planNov), 'Nov 2024', 'Nov 20'), show(await t(rev, THIS_MONTH)));

  const real = ipcMetrics.resolveMetric;
  let asks = 0;
  (ipcMetrics as unknown as { resolveMetric: unknown }).resolveMetric = (...a: Parameters<typeof real>) => { asks++; return real(...a); };
  const span = await t(rev, on('2024-01-15', '2024-04-10'));
  (ipcMetrics as unknown as { resolveMetric: unknown }).resolveMetric = real;
  ok('a span is at most three plan resolutions', asks === 3, String(asks));
  ok('…and adds up to partial Jan + whole Feb–Mar + partial Apr', Object.is(span!.value, 1_000_000 * (17 / 31) + 2_000_000 + 1_000_000 * (10 / 30)) || Math.abs(span!.value! - (1_000_000 * 17 / 31 + 2_000_000 + 1_000_000 * 10 / 30)) < 1e-6, show(span));

  ok('EAST: the plan filtered to East', Object.is((await t(rev, [...THIS_MONTH, eqs('region', 'East')]))!.value, planNovEast * (20 / 30)));
  const ch = (await t(rev, [...THIS_MONTH, eqs('channel', 'web')]))!;
  ok('the plan has no channel: no target, and why', ch.value === null && ch.none === tm.targetPlanLacks('channel') && ch.status === 'none', show(ch));
  const unfiltered = await H.as(H.ORG_A, () => ipcMetrics.resolveMetric(P, planRev.id, { filters: [...on('2024-11-01', '2024-11-30', 'month'), eqs('channel', 'web')] }));
  ok('NEGATIVE CONTROL: left in, that filter would silently give the whole plan', Object.is(unfiltered!.value, planNov), show(unfiltered));
  ok('no period, additive: no target', (await t(rev, []))!.none === tm.targetPickPeriod());
  ok('an open start, additive: no target', (await t(rev, [step('day', '<=', '2024-11-30')]))!.none === tm.targetPickPeriod());
  ok('avg: a fixed figure holds at any scope, never pro-rated', Object.is((await t(avg, THIS_MONTH))!.value, 50) && Object.is((await t(avg, []))!.value, 50));
  const graded = await t(rev, THIS_MONTH, 700_000);
  const want = model.rowStatus(700_000, planNov * (20 / 30), undefined, rev.direction);
  ok('status and attainment are rowStatus\'s', graded!.status === want.status && Object.is(graded!.attainment, want.attainment), show(graded));
  ok('NEGATIVE CONTROL: no figure, no status', (await t(rev, THIS_MONTH, null))!.status === 'none');
  ok('a target on Live actuals with an extract plan works', Object.is((await t(revLive, THIS_MONTH))!.value, planNov * (20 / 30)), show(await t(revLive, THIS_MONTH)));

  // Saving.
  const trySave = async (patch: Record<string, unknown>, id = rev.id): Promise<Reply> => (await post('metric:update', { projectId: P, id, patch })).value;
  ok('save refuses a sum target with no per', (await trySave({ target: { source: { value: 1 } } })).error === tm.targetNeedsPer(), show(await trySave({ target: { source: { value: 1 } } })));
  ok('…beside the target box', (await trySave({ target: { source: { value: 1 } } })).field === 'target');
  ok('save refuses a metric as its own plan', (await trySave({ target: { source: { metricId: rev.id }, per: 'month' } })).error === tm.targetOwnPlan());
  ok('NEGATIVE CONTROL: an average takes a fixed figure with no per', (await trySave({ target: { source: { value: 60 } } }, avg.id)).ok === true);
  const undated = await saved({ name: 'Undated plan', datasetId: PD, definition: { column: 'amount', aggregation: 'sum' } });
  ok('save refuses a plan with no date', (await trySave({ target: { source: { metricId: undated.id }, per: 'month' } })).error === tm.targetPlanNoDate('Undated plan'));
  ok('an old editor\'s update keeps the target', (await trySave({ name: 'Revenue' })).ok === true && isDeepStrictEqual((await metricOf(rev.id)).target, REV_TARGET));
  ok('target: null clears it', (await trySave({ target: null })).ok === true && !('target' in (await metricOf(rev.id))));
  ok('…and saving it again sets it', (await trySave({ target: REV_TARGET })).ok === true && isDeepStrictEqual((await metricOf(rev.id)).target, REV_TARGET));
  ok('the contract refuses a target that is both a figure and a plan', (await post('metric:update', { projectId: P, id: rev.id, patch: { target: { source: { value: 1, metricId: planRev.id } } } })).status === 400);

  // A plan whose metric was deleted: a sentence, not a throw.
  const orphan = await saved({ name: 'Orphan', datasetId: D, definition: { column: 'amount', aggregation: 'sum' }, timeColumn: 'day' });
  await post('metric:update', { projectId: P, id: orphan.id, patch: { target: { source: { metricId: planRev.id }, per: 'month' } } });
  await post('metric:delete', { projectId: P, id: planRev.id });
  ok('a deleted plan: no target, and why', (await t(orphan, THIS_MONTH))!.none === tm.targetPlanGone());
}

async function main(): Promise<void> {
  mathSection();
  await resolveSection();
  await close();
  finish();
}

void main();
