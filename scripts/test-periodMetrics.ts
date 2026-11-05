// Period metrics (semantic layer part 5, step 05: D8, D9, D10's first bullet): "Revenue, year to date", "Orders,
// last 7 days", "Revenue, % change on last year" — a base metric resolved under a rewritten scope.
//
//   math      the days a window covers under any scope and calendar (src/analysis/periodMath.ts), pure
//   kpi       the figure through the KPI door (src/ipc/periodMetric.ts): the base tile under the window, a compare
//             like with like, formulas over one (the memo trap), a date control, Live never hydrated, the save's
//             refusals, a deleted base said; metrics with nothing new reply byte for byte as before (a pinned hash)
//   surfaces  scorecards and the metric tree are tiles; an alert on a period metric watches the metric itself, by
//             period too (a range, never a label filter); one whose metric is gone is left untouched
//
// Every guard has its NEGATIVE CONTROL beside it.
//
//   npm run build:ts && node scripts/test-periodMetrics.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrates, post } from './liveRouteHarness';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { FilterStep } from '../src/data/transforms';
import type { DateRange } from '../src/analysis/dateIntel';
import type { MetricWindow } from '../src/analysis/periodMetric';

const pm: typeof import('../src/analysis/periodMath') = require('../src/analysis/periodMath');
const { resolvePeriod }: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const { createHash }: typeof import('crypto') = require('crypto');

process.env.ORDINATE_TODAY = '2024-11-03'; // after the harness pinned its own: every period below resolves against this day
const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);

const same = (a: DateRange | null | undefined, b: DateRange | null | undefined): boolean => !!a && !!b && a.from === b.from && a.to === b.to;
const ON = (from: string, to: string, column = 'day'): FilterStep => ({ type: 'filter', column, op: 'period', period: { preset: 'custom', from, to } }) as FilterStep;

// ── math ────────────────────────────────────────────────────────────────────
{
  const TODAY = '2024-11-03';
  const D = { name: 'day', type: 'date' };
  const GREG = { weekStart: 1, fiscalYearStart: 1 }, FY4 = { weekStart: 1, fiscalYearStart: 4 }, W445 = { ...GREG, calendarType: '445' as const };
  const REGION_EAST = { type: 'filter', column: 'region', op: '=', value: 'East' } as FilterStep;
  const r = (w: MetricWindow, f: FilterStep[], cal: typeof GREG = GREG) => pm.windowedScope(f, D, w, TODAY, cal).range;
  ok('YTD, no scope = the ytd preset', same(r({ to_date: 'year' }, []), resolvePeriod({ preset: 'ytd' }, TODAY, GREG)));
  ok('YTD, fiscal April, scope October', same(r({ to_date: 'year' }, [ON('2024-10-01', '2024-10-31')], FY4), { from: '2024-04-01', to: '2024-10-31' }));
  ok('QTD = the qtd preset under a week calendar', same(r({ to_date: 'quarter' }, [], W445), resolvePeriod({ preset: 'qtd' }, TODAY, W445)), JSON.stringify([r({ to_date: 'quarter' }, [], W445), resolvePeriod({ preset: 'qtd' }, TODAY, W445)]));
  ok('YTD = the ytd preset under a week calendar too', same(r({ to_date: 'year' }, [], W445), resolvePeriod({ preset: 'ytd' }, TODAY, W445)));
  ok('MTD, February 2024 ends on the 29th', same(r({ to_date: 'month' }, [ON('2024-02-01', '2024-02-29')]), { from: '2024-02-01', to: '2024-02-29' }));
  ok('WTD starts on the workspace week start', same(r({ to_date: 'week' }, []), { from: '2024-10-28', to: TODAY }) && same(r({ to_date: 'week' }, [], { weekStart: 0, fiscalYearStart: 1 }), { from: '2024-11-03', to: TODAY }));
  ok('to date never passes today', r({ to_date: 'month' }, [ON('2024-11-01', '2024-11-30')])!.to === TODAY);
  ok('last 7 days, scope February: the 23rd to the 29th', same(r({ last: 7, unit: 'day' }, [ON('2024-02-01', '2024-02-29')]), { from: '2024-02-23', to: '2024-02-29' }));
  ok('last 7 days, no scope, ends yesterday', r({ last: 7, unit: 'day' }, [])!.to === '2024-11-02');
  ok('last 3 months, scope ending mid-October: whole months only', same(r({ last: 3, unit: 'month' }, [ON('2024-10-01', '2024-10-15')]), resolvePeriod({ preset: 'last_n_months', n: 3 }, '2024-10-16', GREG)));
  ok('last 2 weeks, scope ending on a Sunday: the two whole weeks before it', same(r({ last: 2, unit: 'week' }, [ON('2024-10-01', '2024-10-27')]), { from: '2024-10-14', to: '2024-10-27' }));
  const f = pm.windowedScope([REGION_EAST, ON('2024-10-01', '2024-10-31'), { type: 'filter', column: 'ship', op: '>=', value: '2024-01-01' } as FilterStep], D, { to_date: 'year' }, TODAY, GREG).filters;
  ok('the window replaces only the date bounds on the base\'s date', f.includes(REGION_EAST) && f.some((s) => s.column === 'ship') && f.filter((s) => s.column === 'day').length === 1, JSON.stringify(f));
  ok('… and its one step is the window', same(f.find((s) => s.column === 'day')?.period as DateRange, { from: '2024-01-01', to: '2024-10-31' }));
  const none = pm.windowedScope([REGION_EAST, ON('2024-10-01', '2024-10-31')], D, undefined, TODAY, GREG);
  ok('no window: the filters as they are, and the scope\'s range', none.filters.length === 2 && none.filters[0] === REGION_EAST && same(none.range, { from: '2024-10-01', to: '2024-10-31' }));
  ok('no window and no scope: no range', pm.windowedScope([REGION_EAST], D, undefined, TODAY, GREG).range === null);
  ok('scopeEnd: the scope\'s end, today when open or none', pm.scopeEnd([ON('2024-10-01', '2024-10-31')], D, TODAY) === '2024-10-31' && pm.scopeEnd([{ type: 'filter', column: 'day', op: '>=', value: '2024-10-01' } as FilterStep], D, TODAY) === TODAY && pm.scopeEnd([], D, TODAY) === TODAY);
  ok('windowRange: last 1 month ending at the end of October', same(pm.windowRange({ last: 1, unit: 'month' }, '2024-10-31', TODAY, GREG), { from: '2024-10-01', to: '2024-10-31' }));
  ok('pct_change', pm.pctChange(110, 100) === 0.1 && pm.pctChange(90, -100) === 1.9 && pm.pctChange(5, 0) === null && pm.pctChange(5, null) === null && pm.pctChange(null, 5) === null);
  ok('periodValue: no compare is now, change, % change and prior', pm.periodValue(undefined, 7, 5) === 7 && pm.periodValue('change', 7, 5) === 2 && pm.periodValue('pct_change', 6, 5) === pm.pctChange(6, 5) && pm.periodValue('prior', 7, 5) === 5);
  ok('periodValue: a change with either side missing is no figure', pm.periodValue('change', null, 5) === null && pm.periodValue('change', 7, null) === null && pm.periodValue(undefined, null, 5) === null);
  ok('NEGATIVE CONTROL: a scope on another date column does not move the window', r({ to_date: 'year' }, [{ type: 'filter', column: 'ship', op: 'period', period: { preset: 'last_month' } } as FilterStep])!.to === TODAY);
}

// ── kpi ─────────────────────────────────────────────────────────────────────
// SALES: two rows a day from 2023-01-01 to 2024-11-03, every seventh day written the US way; `ship` a few days later.
const COLS: LiveColumn[] = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'amt', type: 'number' }, { name: 'ship', type: 'date' }];
const iso = (n: number): string => new Date(Date.UTC(2023, 0, 1) + n * 86400000).toISOString().slice(0, 10);
const us = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(0, 4)}`;
const DAYS = 673; // 2023-01-01 … 2024-11-03
const ROWS = Array.from({ length: DAYS * 2 }, (_, i) => {
  const n = i >> 1;
  return [n % 7 === 3 ? us(iso(n)) : iso(n), ['North', 'South', 'East', 'West'][i % 4], ((i * 37) % 101) + (n % 13), iso(n + (i % 5))];
});

void (async () => {
  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;
  const D = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Sales', sourceKind: 'csv', ...H.fx.importTyped(COLS, ROWS) })))!.id;
  // A warehouse holds its days as DATEs (a Live text date reads ISO only: TRY_CAST): the Live copy and its extract twin are ISO.
  const ISO_ROWS = ROWS.map((r, i) => [iso(i >> 1), ...r.slice(1)]);
  const DI = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Sales ISO', sourceKind: 'csv', ...H.fx.importTyped(COLS, ISO_ROWS) })))!.id;
  await H.as(H.ORG_A, () => H.fx.loadWarehouse('sales', COLS, ISO_ROWS));
  const L = (await H.as(H.ORG_A, () => H.liveOver(P, { table: 'sales' }, COLS))).liveId;
  ok('fixture: the last day is 2024-11-03', iso(DAYS - 1) === '2024-11-03');

  const post1 = async (input: Record<string, unknown>): Promise<Reply> => (await post('metric:save', { projectId: P, input: { datasetId: D, ...input } })).value;
  type M = { id: string; name: string; base?: string };
  const saved = async (input: Record<string, unknown>): Promise<M> => {
    const r = await post1(input);
    if (r.ok !== true) throw new Error(`could not save ${String(input.name)}: ${show(r)}`);
    return { id: r.metric.id, name: r.metric.name, base: (input.definition as { base?: string }).base };
  };
  const REVm = await saved({ name: 'Revenue', definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 'day', format: { kind: 'currency', decimals: 0 } });
  const AVGm = await saved({ name: 'Avg sale', definition: { column: 'amt', aggregation: 'avg' }, timeColumn: 'day' });
  const UNITS = await saved({ name: 'Units', definition: { column: 'amt', aggregation: 'count' } });
  const CNT = await saved({ name: 'Sales', definition: { column: 'amt', aggregation: 'count' }, timeColumn: 'day' });
  const SHARE = await saved({ name: 'Per sale', definition: { formula: '[Revenue] / [Sales]' } });
  const REV = REVm.id, AVG = AVGm.id;
  const byId = new Map([[REV, REVm], [AVG, AVGm]]);

  const resolved = async (m: M | string, filters: FilterStep[]): Promise<Reply> => (await H.as(H.ORG_A, () => ipcMetrics.resolveMetric(P, typeof m === 'string' ? m : m.id, { filters }))) as Reply;
  const kpi = async (m: M | string, filters: FilterStep[]): Promise<number | null> => (await resolved(m, filters))?.value ?? null;
  const OCT = ON('2024-10-01', '2024-10-31'), FEB = ON('2024-02-01', '2024-02-29'), Y2023 = ON('2023-01-01', '2023-12-31');
  const EAST = { type: 'filter', column: 'region', op: '=', value: 'East' } as FilterStep;

  // Old content first: a metric with nothing new replies as it did before this step (hash taken on b32f011b).
  const plainReplies: unknown[] = [];
  for (const m of [REVm, AVGm, UNITS, CNT, SHARE]) {
    for (const scope of [[], [OCT], [OCT, EAST], [{ ...ON('2024-10-01', '2024-10-31', 'ship'), fromControl: true } as FilterStep]]) {
      const { id: _id, ...rest } = await resolved(m, scope);
      plainReplies.push(rest);
    }
  }
  const pin = createHash('sha256').update(JSON.stringify(plainReplies)).digest('hex');
  ok('old content: plain and formula metrics reply byte for byte as before', pin === '58afedc107a9445262eed3d45f3fa631b34bec9acab7a59becc803777606c01b', pin);

  const save = (name: string, definition: unknown): Promise<M> => saved({ name, definition });
  const ytd = await save('Revenue YTD', { base: REV, window: { to_date: 'year' } });
  const yoy = await save('Revenue YTD vs LY', { base: REV, window: { to_date: 'year' }, compare: { vs: 'previous_year', show: 'pct_change' } });
  const d7 = await save('Revenue 7d', { base: REV, window: { last: 7, unit: 'day' } });
  const avgYtd = await save('Avg sale YTD', { base: AVG, window: { to_date: 'year' } });
  const label = (scope: readonly FilterStep[]): string => scope.map((x) => `${x.column} ${x.op} ${JSON.stringify(x.period ?? x.value)}`).join(' & ') || 'no scope';
  const cases: [M, FilterStep[], [string, string]][] = [[ytd, [], ['2024-01-01', '2024-11-03']], [ytd, [OCT], ['2024-01-01', '2024-10-31']], [d7, [FEB], ['2024-02-23', '2024-02-29']], [avgYtd, [OCT, EAST], ['2024-01-01', '2024-10-31']]];
  for (const [m, scope, range] of cases) {
    const got = await kpi(m, scope);
    const want = await kpi(byId.get(m.base!)!, [...scope.filter((x) => x.column !== 'day'), ON(...range)]);
    ok(`${m.name} under ${label(scope)} = the base tile under the explicit range`, typeof got === 'number' && Object.is(got, want), show([got, want]));
  }
  ok('NEGATIVE CONTROL: YTD under October is not October', !Object.is(await kpi(ytd, [OCT]), await kpi(REV, [OCT])));
  ok('the tile says which days', same((await resolved(ytd, [OCT])).periodRange, { from: '2024-01-01', to: '2024-10-31' }), show(await resolved(ytd, [OCT])));
  ok('the words: base, year to date', (await resolved(ytd, [])).definitionText === 'Revenue, year to date' && (await resolved(d7, [])).definitionText === 'Revenue, last 7 days', show((await resolved(ytd, [])).definitionText));
  const now = await kpi(ytd, [OCT]), prior = await kpi(REV, [ON('2023-01-01', '2023-10-31')]);
  ok('% change on last year: like with like', typeof now === 'number' && Object.is(await kpi(yoy, [OCT]), (now - prior!) / Math.abs(prior!)), show([await kpi(yoy, [OCT]), now, prior]));
  const whole = (await kpi(REV, [Y2023]))!;
  ok('NEGATIVE CONTROL: not against the whole of last year', !Object.is(await kpi(yoy, [OCT]), (now! - whole) / Math.abs(whole)));
  ok('% change with no scope: the year to today against last year to the same day', Object.is(await kpi(yoy, []), pm.pctChange(await kpi(ytd, []), await kpi(REV, [ON('2023-01-01', '2023-11-03')]))));
  const diff = await saved({ name: 'YTD less month', definition: { formula: '[Revenue YTD] - [Revenue]' } });
  ok('a formula over a period metric: the base keeps its own scope (the memo trap)', Object.is(await kpi(diff, [OCT]), (await kpi(ytd, [OCT]))! - (await kpi(REV, [OCT]))!) && (await kpi(diff, [OCT])) !== 0, show(await kpi(diff, [OCT])));
  const ytdShare = await save('Per sale YTD', { base: SHARE.id, window: { to_date: 'year' } });
  ok('a formula base: each part under the window', Object.is(await kpi(ytdShare, [OCT]), (await kpi(SHARE, [ON('2024-01-01', '2024-10-31')]))), show([await kpi(ytdShare, [OCT]), await kpi(SHARE, [ON('2024-01-01', '2024-10-31')])]));
  const cmpOnly = await save('Revenue vs LY', { base: REV, compare: { vs: 'previous_year', show: 'change' } });
  ok('compare with no window and no period: null, and why', (await kpi(cmpOnly, [])) === null && (await resolved(cmpOnly, [])).notes?.[0] === msg.pickPeriodToCompare(), show(await resolved(cmpOnly, [])));
  ok('NEGATIVE CONTROL: … with a period in scope it is the change on last year', Object.is(await kpi(cmpOnly, [OCT]), (await kpi(REV, [OCT]))! - (await kpi(REV, [ON('2023-10-01', '2023-10-31')]))!) && (await resolved(cmpOnly, [OCT])).notes === undefined);
  const priorOnly = await save('Revenue LY', { base: REV, compare: { vs: 'previous_year', show: 'prior' } });
  ok('prior: last year\'s figure', Object.is(await kpi(priorOnly, [OCT]), await kpi(REV, [ON('2023-10-01', '2023-10-31')])) && (await resolved(priorOnly, [])).definitionText === 'Revenue, last year');
  const ON_SHIP_OCT = { ...ON('2024-10-01', '2024-10-31', 'ship'), fromControl: true } as FilterStep;
  ok('a date control lands on the base\'s date first (part 1 D9)', Object.is(await kpi(ytd, [ON_SHIP_OCT]), await kpi(ytd, [OCT])) && (await resolved(ytd, [ON_SHIP_OCT])).periodOn === 'day');
  ok('NEGATIVE CONTROL: a plain filter on another date is not moved', !Object.is(await kpi(ytd, [ON('2024-10-01', '2024-10-31', 'ship')]), await kpi(ytd, [OCT])));

  // Live: the same figure through the Live door, never hydrated.
  const REVL = (await post('metric:save', { projectId: P, input: { name: 'Live revenue', datasetId: L, definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 'day' } })).value.metric.id as string;
  const ytdL = (await post('metric:save', { projectId: P, input: { name: 'Live revenue YTD', datasetId: L, definition: { base: REVL, window: { to_date: 'year' } } } })).value.metric.id as string;
  const yoyL = (await post('metric:save', { projectId: P, input: { name: 'Live YoY', datasetId: L, definition: { base: REVL, window: { to_date: 'year' }, compare: { vs: 'previous_year', show: 'pct_change' } } } })).value.metric.id as string;
  const onIso = async (definition: unknown, name: string): Promise<string> => (await post1({ datasetId: DI, name, definition, ...('column' in (definition as object) ? { timeColumn: 'day' } : {}) })).metric.id;
  const REVI = await onIso({ column: 'amt', aggregation: 'sum' }, 'ISO revenue');
  const ytdI = await onIso({ base: REVI, window: { to_date: 'year' } }, 'ISO revenue YTD');
  const yoyI = await onIso({ base: REVI, window: { to_date: 'year' }, compare: { vs: 'previous_year', show: 'pct_change' } }, 'ISO YoY');
  const lv = await hydrates(L, () => kpi(ytdL, [OCT]));
  ok('Live: the extract\'s figure, never hydrated', typeof lv.value === 'number' && Object.is(lv.value, await kpi(ytdI, [OCT])) && !lv.hydrated, show([lv, await kpi(ytdI, [OCT])]));
  ok('Live: … which is the Live base under the explicit range', Object.is(lv.value, await kpi(REVL, [ON('2024-01-01', '2024-10-31')])));
  const lc = await hydrates(L, () => kpi(yoyL, [OCT]));
  ok('Live: a compare too', typeof lc.value === 'number' && Object.is(lc.value, await kpi(yoyI, [OCT])) && !lc.hydrated, show(lc));
  ok('no sparkline until step 06', (await H.as(H.ORG_A, () => ipcMetrics.resolveMetricSeries(P, ytd.id, 'day'))) === null);
  ok('NEGATIVE CONTROL: the base has its sparkline', ((await H.as(H.ORG_A, () => ipcMetrics.resolveMetricSeries(P, REV, 'day')))?.values.length ?? 0) > 0);
  const timeScope: typeof import('../src/analysis/metricTimeScope') = require('../src/analysis/metricTimeScope');
  const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
  const dateOf = async (id: string): Promise<string> => H.as(H.ORG_A, async () => timeScope.metricDate(P, (await metricsMod.getMetric(P, id))!));
  ok('a period metric counts by its base\'s date, and stores none of its own', (await dateOf(ytd.id)) === 'day' && (await H.as(H.ORG_A, () => metricsMod.getMetric(P, ytd.id)))?.timeColumn === undefined);
  ok('NEGATIVE CONTROL: … over a base with no date it has none', (await dateOf(UNITS.id)) === '');
  const usage: typeof import('../src/analysis/metricUsage') = require('../src/analysis/metricUsage');
  const used = await H.as(H.ORG_A, () => usage.metricUsage(P, REV));
  ok('usage: a period metric uses its base', used.refs.some((r) => r.id === ytd.id && r.kind === 'metric'), show(used));
  ok('NEGATIVE CONTROL: … and nothing else\'s', !(await H.as(H.ORG_A, () => usage.metricUsage(P, AVG))).refs.some((r) => r.id === ytd.id));

  // Agents: list_metrics says it in words, metric_value gives the tile's figure.
  const handlers: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
  const listed = (await H.as(H.ORG_A, () => handlers.metricsList({ projectId: P } as never))) as Reply[];
  ok('MCP list_metrics: a period metric in words, counting by its base\'s date', listed.find((m) => m.id === ytd.id)?.definition === 'Revenue, year to date' && listed.find((m) => m.id === ytd.id)?.counts_by === 'day', show(listed.find((m) => m.id === ytd.id)));
  const mv = (await H.as(H.ORG_A, () => handlers.metricValue({ projectId: P } as never, 'Revenue YTD'))) as Reply;
  ok('MCP metric_value: the tile\'s figure', typeof mv.value === 'number' && Object.is(mv.value, await kpi(ytd, [])), show(mv));

  // ── surfaces ──────────────────────────────────────────────────────────────
  const scorecards: typeof import('../src/ipc/scorecards') = require('../src/ipc/scorecards');
  const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
  const { randomUUID }: typeof import('crypto') = require('crypto');
  const sc = (await H.as(H.ORG_A, () => scorecards.computeScorecard(P, { id: randomUUID(), projectId: P, name: 's', period: 'month', rows: [{ metricId: ytd.id }], createdAt: '', updatedAt: '', schemaVersion: 1 } as never))) as Reply;
  ok('scorecard: the row is the tile under the scorecard\'s window', typeof sc.rows?.[0]?.value === 'number' && Object.is(sc.rows[0].value, await kpi(ytd, [ON(sc.window.from, sc.window.to)])), show(sc.rows?.[0]));
  const detail = (await H.as(H.ORG_A, () => scorecards.scorecardDetail(P, { id: randomUUID(), projectId: P, name: 's', period: 'month', rows: [{ metricId: ytd.id }], createdAt: '', updatedAt: '', schemaVersion: 1 } as never, ytd.id))) as Reply;
  ok('scorecard detail: in the period metric\'s words', detail.metric?.definitionText === 'Revenue, year to date', show(detail.metric));
  const tree = (await post('metricTree:compute', { projectId: P, id: ytd.id, filters: [OCT], compare: { mode: 'previous_year' } })).value;
  ok('tree: current and previous are tiles', typeof tree.root?.current === 'number' && Object.is(tree.root.current, await kpi(ytd, [OCT])) && Object.is(tree.root.previous, await kpi(ytd, [ON('2023-10-01', '2023-10-31')])), show(tree));
  const rule = { id: randomUUID(), name: 'r', datasetId: D, enabled: true, compare: 'threshold', threshold: { op: '>', value: 0 }, metric: { column: '', aggregation: 'sum', metricId: ytd.id, filters: [OCT] } };
  const watched = await H.as(H.ORG_A, () => alertStore.metricFor(P, rule as never));
  ok('an alert on a period metric watches its figure', typeof watched.value === 'number' && Object.is(watched.value, await kpi(ytd, [OCT])), show(watched));
  ok('NEGATIVE CONTROL: an alert on a plain metric still uses its copy', Object.is((await H.as(H.ORG_A, () => alertStore.metricFor(P, { ...rule, metric: { column: 'amt', aggregation: 'sum', metricId: REV } } as never))).value, await kpi(REV, [])));
  // By period: YTD to the end of the latest closed month, against YTD to the end of the one before — never a month alone.
  const change = { ...rule, id: randomUUID(), datasetId: DI, compare: 'change', threshold: undefined, change: { op: 'pct_up', value: 1, vs: 'previous_period', periodColumn: 'day' }, metric: { column: '', aggregation: 'sum', metricId: ytdI } };
  const byPeriod = await H.as(H.ORG_A, () => alertStore.metricFor(P, change as never));
  ok('a change rule by period: the YTD to each month\'s end', byPeriod.period === '2024-10' && Object.is(byPeriod.value, await kpi(ytdI, [ON('2024-10-01', '2024-10-31')])) && Object.is(byPeriod.previous, await kpi(ytdI, [ON('2024-09-01', '2024-09-30')])), show(byPeriod));
  ok('NEGATIVE CONTROL: … not October alone (a label filter would give it)', typeof byPeriod.value === 'number' && !Object.is(byPeriod.value, await kpi(REVI, [ON('2024-10-01', '2024-10-31')])));
  const gone = await save('Short-lived YTD', { base: REV, window: { to_date: 'year' } });
  const ruleGone = { ...rule, id: randomUUID(), metric: { ...rule.metric, metricId: gone.id } };
  await post('metric:delete', { projectId: P, id: gone.id });
  for (const r of [rule, ruleGone]) await H.as(H.ORG_A, () => alertStore.restoreRule(P, r));
  const before = await H.as(H.ORG_A, () => alertStore.load(P));
  await H.as(H.ORG_A, () => alertStore.evaluateProject(P, D, Date.parse('2024-11-03T12:00:00Z')));
  const after = await H.as(H.ORG_A, () => alertStore.load(P));
  const at = (f: typeof before, id: string) => f.rules.find((x) => x.id === id);
  ok('an alert tick evaluates the period rule: its figure, and it fires', Object.is(at(after, rule.id)?.lastValue, await kpi(ytd, [OCT])) && typeof at(after, rule.id)?.lastFiredAt === 'string', show(at(after, rule.id)));
  ok('a rule whose metric is gone is left as it was, never evaluated as nothing', JSON.stringify(at(after, ruleGone.id)) === JSON.stringify(at(before, ruleGone.id)) && at(after, ruleGone.id)?.lastEvaluatedAt === undefined, show(at(after, ruleGone.id)));
  const tested = await H.as(H.ORG_A, () => alertStore.testRule(P, rule));
  ok('the Test button: the period figure', tested.ok && tested.fire === true && Object.is(tested.value, await kpi(ytd, [OCT])), show(tested));

  // The save's refusals, each beside its field.
  const trySave = async (definition: unknown, timeColumn?: string): Promise<Reply> => post1({ name: 'Probe', definition, ...(timeColumn !== undefined ? { timeColumn } : {}) });
  const GONE = '99999999-9999-4999-8999-999999999999';
  const W = { to_date: 'year' };
  const refusals: [unknown, string | undefined, string, string][] = [
    [{ base: GONE, window: W }, undefined, msg.periodBaseMissing(), 'definition'],
    [{ base: REVL, window: W }, undefined, msg.periodBaseOtherDataset(), 'definition'],
    [{ base: UNITS.id, window: W }, undefined, msg.periodBaseNoDate('Units'), 'definition'],
    [{ base: ytd.id, window: W }, undefined, msg.periodOfPeriod(), 'definition'],
    [{ base: REV, window: W }, 'ship', msg.periodOwnDate(), 'timeColumn'],
  ];
  for (const [def, tc, err, field] of refusals) {
    const r = await trySave(def, tc);
    ok(`save refuses: ${err}`, r.ok === false && r.error === err && r.field === field, show(r));
  }
  ok('NEGATIVE CONTROL: nothing was saved by the refusals', !(await post('metric:list', { projectId: P })).value.metrics.some((m: Reply) => m.name === 'Probe'));
  ok('the contract refuses a period metric with neither a window nor a compare', (await post('metric:save', { projectId: P, input: { name: 'Bare', datasetId: D, definition: { base: REV } } })).status === 400);
  const upd = await post('metric:update', { projectId: P, id: ytd.id, patch: { timeColumn: 'ship' } });
  ok('update refuses a date of its own too', upd.value.ok === false && upd.value.error === msg.periodOwnDate(), show(upd.value));
  ok('NEGATIVE CONTROL: a rename of a period metric saves', (await post('metric:update', { projectId: P, id: d7.id, patch: { name: 'Revenue last 7d' } })).value.ok === true);

  await post('metric:delete', { projectId: P, id: REV });
  ok('a deleted base: null and why, never a copy', (await kpi(ytd, [])) === null && (await resolved(ytd, [])).notes?.[0] === msg.periodBaseMissing(), show(await resolved(ytd, [])));

  await close();
  finish();
})().catch((err) => {
  ok('test-periodMetrics ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
