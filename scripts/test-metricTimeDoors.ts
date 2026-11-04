// The date a metric counts by (semantic layer D9, PR 04), over the real RPC route. The harness of the whole PR:
// Task 3 saves and reads the date (below); the doors that rewrite a dashboard control's period onto it join it.
//
//   save      a column that is not a date is refused beside its field; a formula takes the date its parts share
//   datasets  a formula's parts are compared within one dataset only; an inherited date is a column of the formula's own
//   update    set, clear, and re-checked only when the patch can change the answer; a new definition re-takes its parts' date
//   read      the list carries it; a column that is gone is flagged by metric:get, counts as unset and blocks no edit
//   restore   a version brings the date back, or clears it
//   charts    under a date control the period lands on the metric's date (Task 4): the chart door, visual:data's compare
//             and reference lines, drill rows, Explain a point and Explain; measures, formula parts or two controls that
//             disagree are refused; a pivot keeps release 1's refusal; no mark means the same steps and no read; Live too
//
// NEGATIVE CONTROLS sit beside each refusal: the same save on a valid date, a formula whose parts agree, a patch that
// touches neither the definition nor the date.
//
//   npm run build:ts && node scripts/test-metricTimeDoors.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrates, post } from './liveRouteHarness';
import type { LiveColumn } from '../src/engine/live/liveSpec';

const { randomUUID }: typeof import('crypto') = require('crypto');

const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const scope: typeof import('../src/analysis/metricTimeScope') = require('../src/analysis/metricTimeScope');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');

const { ORG_A, fx } = H;
const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);

const COLS: LiveColumn[] = [{ name: 'region', type: 'text' }, { name: 'amt', type: 'number' }, { name: 'order_date', type: 'date' }, { name: 'ship_date', type: 'date' }];
const day = (n: number): string => new Date(Date.UTC(2024, 0, 1) + n * 86400000).toISOString().slice(0, 10);
const rows = Array.from({ length: 1200 }, (_, i) => [['North', 'South', 'East', 'West'][i % 4], (i % 13) + 1, day(i % 400), day((i % 400) + (i % 7))]);

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const D = (await H.as(ORG_A, () => H.datasets.saveDataset(P, { name: 'Two dates', sourceKind: 'csv', ...fx.importTyped(COLS, rows) })))!.id;
  await H.as(ORG_A, () => fx.loadWarehouse('two_dates', COLS, rows));
  const DL = (await H.as(ORG_A, () => H.liveOver(P, { table: 'two_dates' }, COLS))).liveId;

  const save = async (input: Record<string, unknown>): Promise<Reply> => (await post('metric:save', { projectId: P, input: { datasetId: D, ...input } })).value;
  const update = async (id: string, patch: Record<string, unknown>): Promise<Reply> => (await post('metric:update', { projectId: P, id, patch })).value;
  const storedDate = async (id: string): Promise<string | undefined> => { // the record on disk, read as the org; a missing record throws, so it never reads as "no date"
    const m = await H.as(ORG_A, () => metricsMod.getMetric(P, id));
    if (!m) throw new Error(`metric ${id} is not stored`);
    return m.timeColumn;
  };
  const SUM = { column: 'amt', aggregation: 'sum' } as const;
  const COUNT = { column: 'amt', aggregation: 'count' } as const;

  // ── Save: the column must be a date column of the dataset ──────────────────
  const bad = await save({ name: 'Bad', definition: SUM, timeColumn: 'region' });
  ok('a column that is not a date is refused beside its field', bad.ok === false && bad.field === 'timeColumn' && /not a date column/.test(bad.error), show(bad));
  ok('… and says which column', bad.error === msg.notADateColumn('region'), show(bad));
  const missing = await save({ name: 'Bad', definition: SUM, timeColumn: 'nope' });
  ok('a column the dataset does not have is refused the same way', missing.ok === false && missing.field === 'timeColumn' && missing.error === msg.notADateColumn('nope'), show(missing));
  ok('NEGATIVE CONTROL: nothing was saved by the refusals', (await post('metric:list', { projectId: P })).value.metrics.filter((m: Reply) => m.name === 'Bad').length === 0);

  const REV = (await save({ name: 'Revenue', definition: SUM, timeColumn: 'ship_date' })).metric.id as string;
  const ORD = (await save({ name: 'Orders', definition: COUNT })).metric.id as string;
  ok('NEGATIVE CONTROL: a date column saves, and a metric without one carries none',
    (await storedDate(REV)) === 'ship_date' && (await storedDate(ORD)) === undefined);
  ok('NEGATIVE CONTROL: a blank timeColumn on save is no date', (await save({ name: 'Blank', definition: COUNT, timeColumn: '' })).metric.timeColumn === undefined);
  const padded = await save({ name: 'Padded', definition: COUNT, timeColumn: ' ship_date ' });
  ok('a date with spaces around it is checked and stored trimmed', padded.ok === true && padded.metric.timeColumn === 'ship_date' && (await storedDate(padded.metric.id)) === 'ship_date', show(padded));
  const orphan = await save({ name: 'Orphan', datasetId: randomUUID(), definition: COUNT, timeColumn: 'ship_date' });
  ok('a dataset that is not there says so, not that the date is wrong', orphan.ok === false && orphan.field === undefined && /dataset still exists/.test(orphan.error), show(orphan));
  const check = (timeColumn: string | undefined) => H.as(ORG_A, () => scope.checkTimeColumn(P, { name: 'Probe', datasetId: D, definition: SUM, timeColumn }));
  ok('checkTimeColumn: the sentence for a column that is not a date, null for one that is or for none', (await check('region')) === msg.notADateColumn('region') && (await check('ship_date')) === null && (await check(undefined)) === null);

  // ── Save: a formula counts by one date, the one its parts share ────────────
  const inherits = await save({ name: 'Double', definition: { formula: '[Revenue] * 2' } });
  ok('a formula saved with no date takes the date its part counts by', inherits.ok === true && inherits.metric.timeColumn === 'ship_date', show(inherits));
  ok('… and it is the stored record that carries it', (await storedDate(inherits.metric.id)) === 'ship_date');
  const inlineToo = await save({ name: 'Double plus', definition: { formula: '[Revenue] + sum(amt)' } });
  ok('an inline sum beside the part does not change the date', inlineToo.ok === true && inlineToo.metric.timeColumn === 'ship_date', show(inlineToo));
  const plain = await save({ name: 'Plain twice', definition: { formula: '[Orders] * 2' } });
  ok('NEGATIVE CONTROL: a formula over parts with no date has none', plain.ok === true && plain.metric.timeColumn === undefined, show(plain));
  const none = await save({ name: 'No parts', definition: { formula: 'sum(amt) / count(amt)' } });
  ok('NEGATIVE CONTROL: a formula with no metric parts has none', none.ok === true && none.metric.timeColumn === undefined, show(none));

  const other = await save({ name: 'Elsewhere', definition: { formula: '[Revenue] * 2' }, timeColumn: 'order_date' });
  ok('a formula whose own date differs from its part is refused beside the date, naming the part and both dates',
    other.ok === false && other.field === 'timeColumn' && other.error === msg.formulaDatesDiffer('Elsewhere', 'Revenue', 'ship_date', 'order_date'), show(other));
  ok('NEGATIVE CONTROL: the same formula on the part\'s date saves', (await save({ name: 'Elsewhere', definition: { formula: '[Revenue] * 2' }, timeColumn: 'ship_date' })).ok === true);
  const ownOnly = await save({ name: 'Dated on its own', definition: { formula: '[Orders] * 2' }, timeColumn: 'order_date' });
  ok('a part with no date counts by the dashboard\'s date, and the sentence says so',
    ownOnly.ok === false && ownOnly.error === msg.formulaDatesDiffer('Dated on its own', 'Orders', msg.dashboardDate(), 'order_date') && /dashboard’s date/.test(ownOnly.error), show(ownOnly));

  // Orders counts by order_date for a while: Revenue and Orders then disagree.
  const set = await update(ORD, { timeColumn: 'order_date' });
  const split = await save({ name: 'Per order', definition: { formula: '[Revenue] / [Orders]' } });
  ok('a formula over parts that count by different dates is refused, naming both dates',
    split.ok === false && split.field === 'timeColumn' && split.error === msg.formulaPartsDiffer('Per order', 'Revenue', 'ship_date', 'Orders', 'order_date') && /ship_date/.test(split.error) && /order_date/.test(split.error), show(split));
  const splitOne = await save({ name: 'Per order', definition: { formula: '[Revenue] / [Orders]' }, timeColumn: 'ship_date' });
  ok('… and an explicit date still has to match every part', splitOne.ok === false && splitOne.error === msg.formulaDatesDiffer('Per order', 'Orders', 'order_date', 'ship_date'), show(splitOne));
  const same = await save({ name: 'Per order', definition: { formula: '[Revenue] / [Orders]' }, timeColumn: 'order_date' });
  ok('… and an explicit date still has to match every part (the other side)', same.ok === false && same.error === msg.formulaDatesDiffer('Per order', 'Revenue', 'ship_date', 'order_date'), show(same));

  // ── Update: set, clear, and the re-check ───────────────────────────────────
  const cleared = await update(ORD, { timeColumn: '' });
  const half = await save({ name: 'Half', definition: { formula: '[Revenue] / [Orders]' } });
  ok('a part with no date against one with a date is the same disagreement', half.error === msg.formulaPartsDiffer('Half', 'Revenue', 'ship_date', 'Orders', msg.dashboardDate()), show(half));
  const set2 = await update(ORD, { timeColumn: 'order_date' });
  const cleared2 = await update(ORD, { timeColumn: '' });
  ok('update sets it, and an empty timeColumn clears it', set.ok && set.metric.timeColumn === 'order_date' && set2.metric.timeColumn === 'order_date' && cleared.ok && cleared.metric.timeColumn === undefined && cleared2.metric.timeColumn === undefined, show([set, cleared]));
  ok('NEGATIVE CONTROL: a patch with no timeColumn leaves it alone', (await update(REV, { description: 'by ship date' })).metric.timeColumn === 'ship_date');
  const badUp = await update(ORD, { timeColumn: 'region' });
  ok('update refuses a column that is not a date beside its field, and stores nothing', badUp.ok === false && badUp.field === 'timeColumn' && (await storedDate(ORD)) === undefined, show(badUp));

  const DBL = inherits.metric.id as string;
  const keeps = await update(DBL, { definition: { formula: '[Orders] * 3' } });
  ok('a definition patch whose new parts carry no date keeps the stored date', keeps.ok === true && keeps.metric.timeColumn === 'ship_date', show(keeps));
  ok('NEGATIVE CONTROL: the same patch on parts with a date saves', (await update(DBL, { definition: { formula: '[Revenue] * 3' } })).ok === true);
  ok('a formula patched to a date its part does not count by is refused', (await update(DBL, { timeColumn: 'order_date' })).error === msg.formulaDatesDiffer('Double', 'Revenue', 'ship_date', 'order_date'));
  ok('clearing a formula\'s date gives it back the date its part counts by', (await update(DBL, { timeColumn: '' })).metric.timeColumn === 'ship_date');
  await update(REV, { timeColumn: 'order_date' }); // a part's date moves; nothing re-checks the formulas over it
  const renamed = await update(DBL, { name: 'Double renamed' });
  ok('NEGATIVE CONTROL: a patch of the name alone is not re-checked, and keeps the date', renamed.ok === true && renamed.metric.timeColumn === 'ship_date', show(renamed));
  const moved = await update(DBL, { definition: { formula: '[Revenue] * 4' } });
  ok('a definition patch with no date takes its new parts\' shared date, replacing the stored one', moved.ok === true && moved.metric.timeColumn === 'order_date' && (await storedDate(DBL)) === 'order_date', show(moved));
  const apart = await update(DBL, { definition: { formula: '[Revenue] / [Orders]' } });
  ok('… and parts that disagree are refused, the stored date being no excuse', apart.field === 'timeColumn' && apart.error === msg.formulaPartsDiffer('Double renamed', 'Revenue', 'order_date', 'Orders', msg.dashboardDate()), show(apart));
  const named = await update(DBL, { definition: { formula: '[Revenue] * 5' }, timeColumn: 'ship_date' });
  ok('NEGATIVE CONTROL: a date named in the patch is checked, not replaced', named.field === 'timeColumn' && named.error === msg.formulaDatesDiffer('Double renamed', 'Revenue', 'order_date', 'ship_date') && (await storedDate(DBL)) === 'order_date', show(named));
  await update(REV, { timeColumn: 'ship_date' });

  // ── Formulas over metrics of other datasets: dates are compared within one dataset ──
  const TCOLS: LiveColumn[] = [{ name: 'region', type: 'text' }, { name: 'target', type: 'number' }, { name: 'month', type: 'date' }];
  const Y = (await H.as(ORG_A, () => H.datasets.saveDataset(P, { name: 'Targets', sourceKind: 'csv', ...fx.importTyped(TCOLS, [['North', 100, '2024-01-01'], ['South', 90, '2024-02-01']]) })))!.id;
  await save({ datasetId: Y, name: 'Target', definition: { column: 'target', aggregation: 'sum' }, timeColumn: 'month' });
  await save({ name: 'Shipped', definition: COUNT, timeColumn: 'ship_date' });
  const KPI = { formula: '[Revenue] / [Target]' }; // revenue counts by ship_date on Orders, the target by month on Targets
  const onX = await save({ name: 'Revenue per target', definition: KPI });
  ok('parts on different datasets do not conflict on a column name: the formula saves', onX.ok === true, show(onX));
  ok('… and takes the date of the part on its own dataset', onX.metric.timeColumn === 'ship_date', show(onX));
  const onY = await save({ datasetId: Y, name: 'Target per revenue', definition: KPI });
  ok('… from either side', onY.ok === true && onY.metric.timeColumn === 'month', show(onY));
  ok('NEGATIVE CONTROL: its own date still has to match the part on its dataset', (await save({ name: 'Mixed', definition: KPI, timeColumn: 'order_date' })).error === msg.formulaDatesDiffer('Mixed', 'Revenue', 'ship_date', 'order_date'));
  ok('an explicit date saves beside a part on another dataset', (await save({ name: 'Mixed', definition: KPI, timeColumn: 'ship_date' })).ok === true);
  const onLive = await save({ datasetId: DL, name: 'Live KPI', definition: KPI });
  ok('a formula on a dataset none of its parts is on takes no date', onLive.ok === true && onLive.metric.timeColumn === undefined, show(onLive));
  const shared = { formula: '[Revenue] + [Shipped]' }; // both on Orders, both ship_date
  const away = await save({ datasetId: Y, name: 'Shipped away', definition: shared });
  const away2 = (await post('metric:get', { projectId: P, id: away.metric.id })).value;
  ok('parts that share a date, on a dataset without that column, give the formula none: it is not flagged gone', away.ok === true && away.metric.timeColumn === undefined && away2.timeColumnGone === undefined, show([away, away2]));
  ok('NEGATIVE CONTROL: the same formula on the parts\' own dataset takes it', (await save({ name: 'Shipped home', definition: shared })).metric.timeColumn === 'ship_date');
  await update(ORD, { timeColumn: 'order_date' });
  const crossSplit = await save({ datasetId: Y, name: 'Cross split', definition: { formula: '[Revenue] / [Orders]' } });
  ok('two parts on one dataset with different dates are refused wherever the formula sits', crossSplit.field === 'timeColumn' && crossSplit.error === msg.formulaPartsDiffer('Cross split', 'Revenue', 'ship_date', 'Orders', 'order_date'), show(crossSplit));
  await update(ORD, { timeColumn: '' });

  // ── Read: the list, and a date that is gone ────────────────────────────────
  ok('the list carries it', (await post('metric:list', { projectId: P })).value.metrics.find((m: Reply) => m.id === REV).timeColumn === 'ship_date');
  ok('NEGATIVE CONTROL: the list carries none for a metric without one', !('timeColumn' in (await post('metric:list', { projectId: P })).value.metrics.find((m: Reply) => m.id === ORD)));
  const GONE = (await H.as(ORG_A, () => metricsMod.saveMetric(P, { name: 'Gone date', datasetId: D, definition: SUM, timeColumn: 'gone' })))!.id; // saveMetric skips the handler's check
  const NOTDATE = (await H.as(ORG_A, () => metricsMod.saveMetric(P, { name: 'Text date', datasetId: D, definition: SUM, timeColumn: 'region' })))!.id;
  ok('metric:get flags a date column that no longer exists', (await post('metric:get', { projectId: P, id: GONE })).value.timeColumnGone === true);
  ok('… and one that is no longer a date column', (await post('metric:get', { projectId: P, id: NOTDATE })).value.timeColumnGone === true);
  const revGet = (await post('metric:get', { projectId: P, id: REV })).value;
  ok('NEGATIVE CONTROL: a metric on a real date column has no flag', revGet.ok === true && revGet.timeColumnGone === undefined && revGet.metric.timeColumn === 'ship_date', show(revGet));
  ok('NEGATIVE CONTROL: a metric with no date has no flag', (await post('metric:get', { projectId: P, id: ORD })).value.timeColumnGone === undefined);

  const date = (m: { datasetId: string; timeColumn?: string }): Promise<string> => H.as(ORG_A, () => scope.metricDate(P, m));
  ok('metricDate: a column that is gone counts as unset', (await date({ datasetId: D, timeColumn: 'gone' })) === '');
  ok('metricDate: so does a column that is no longer a date', (await date({ datasetId: D, timeColumn: 'region' })) === '');
  ok('metricDate: unset is unset', (await date({ datasetId: D })) === '');
  ok('NEGATIVE CONTROL: a date column is itself', (await date({ datasetId: D, timeColumn: 'ship_date' })) === 'ship_date');

  // ── A date that is gone counts as unset and blocks no edit ──────────────────
  const E = (await H.as(ORG_A, () => H.datasets.saveDataset(P, { name: 'Shortlived', sourceKind: 'csv', ...fx.importTyped(COLS, rows.slice(0, 50)) })))!.id;
  const STALE = (await save({ datasetId: E, name: 'Stale date', definition: SUM, timeColumn: 'ship_date' })).metric.id as string;
  await H.as(ORG_A, () => H.datasets.updateSteps(P, E, [{ type: 'drop_column', column: 'ship_date' }]));
  ok('the dropped column is flagged by metric:get', (await post('metric:get', { projectId: P, id: STALE })).value.timeColumnGone === true);
  ok('a patch of the name saves', (await update(STALE, { name: 'Stale date renamed' })).ok === true);
  const redefined = await update(STALE, { definition: COUNT });
  ok('a patch of the definition saves too, and leaves the stale date as it was', redefined.ok === true && (await storedDate(STALE)) === 'ship_date', show(redefined));
  ok('NEGATIVE CONTROL: naming that column again is refused', (await update(STALE, { timeColumn: 'ship_date' })).error === msg.notADateColumn('ship_date'));
  const overStale = await save({ datasetId: E, name: 'Over stale', definition: { formula: '[Stale date renamed] * 2' } });
  ok('a part whose date is gone counts as unset: the formula over it takes none', overStale.ok === true && overStale.metric.timeColumn === undefined, show(overStale));

  // ── A Live dataset: schema only, never hydrated ────────────────────────────
  const liveOk = await hydrates(DL, async () => (await post('metric:save', { projectId: P, input: { name: 'Live revenue', datasetId: DL, definition: SUM, timeColumn: 'ship_date' } })).value);
  ok('a Live metric saves its date from the schema', liveOk.value.ok === true && liveOk.value.metric.timeColumn === 'ship_date', show(liveOk.value));
  ok('… and the check read no rows', liveOk.hydrated === false);
  const liveFormula = await hydrates(DL, async () => (await post('metric:save', { projectId: P, input: { name: 'Live twice', datasetId: DL, definition: { formula: '[Live revenue] * 2' } } })).value);
  ok('a formula on a Live dataset takes its part\'s date, reading no rows', liveFormula.value.ok === true && liveFormula.value.metric.timeColumn === 'ship_date' && liveFormula.hydrated === false, show(liveFormula.value));
  const liveBad = await post('metric:save', { projectId: P, input: { name: 'Live bad', datasetId: DL, definition: SUM, timeColumn: 'amt' } });
  ok('a Live column that is not a date is refused', liveBad.value.ok === false && liveBad.value.field === 'timeColumn', show(liveBad.value));
  ok('metricDate on a Live dataset', (await date({ datasetId: DL, timeColumn: 'ship_date' })) === 'ship_date' && (await date({ datasetId: DL, timeColumn: 'gone' })) === '');

  // ── Restore: a version brings the date back, or clears it ──────────────────
  const R = (await save({ name: 'Restorable', definition: COUNT, timeColumn: 'order_date' })).metric.id as string;
  await update(R, { timeColumn: '' });
  const list = async (): Promise<Reply[]> => (await post('versions:list', { projectId: P, type: 'metric', id: R })).value as unknown as Reply[];
  const [withoutDate, withDate] = await list(); // newest first
  const restore = async (key: string): Promise<Reply> => (await post('versions:restore', { projectId: P, type: 'metric', id: R, key })).value;
  const back = await restore(withDate.key);
  ok('restoring a version writes its date back', back.ok === true && (await storedDate(R)) === 'order_date', show(back));
  const gone = await restore(withoutDate.key);
  ok('NEGATIVE CONTROL: restoring a version that had none clears it', gone.ok === true && (await storedDate(R)) === undefined, show(gone));

  // ── Charts under a dashboard date control (Task 4) ──────────────────────────
  // Revenue counts by ship_date, Orders by none. March 2024 by ship_date is another set of rows than by order_date.
  const CTRL = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from: '2024-03-01', to: '2024-03-31' }, fromControl: true };
  const ON = (column: string) => ({ type: 'filter', column, op: 'period', period: CTRL.period });
  const byRegion = (id: string, agg = 'sum') => ({ category: 'region', values: [{ column: 'amt', aggregation: agg, metricId: id }] });
  const chart = async (datasetId: string, encoding: unknown, extra: Record<string, unknown> = {}): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId, encoding, ...extra })).value;
  const REVL = liveOk.value.metric.id as string; // Revenue on the Live twin, by ship_date

  const a = await chart(D, byRegion(REV), { filters: [CTRL] });
  const b = await chart(D, byRegion(REV), { filters: [ON('ship_date')] });
  ok('the control lands on the metric\'s date', a.ok === true && JSON.stringify(a.data) === JSON.stringify(b.data) && a.periodOn === 'ship_date', show(a));
  ok('NEGATIVE CONTROL: the control\'s own column is a different figure', JSON.stringify(a.data) !== JSON.stringify((await chart(D, byRegion(REV), { filters: [ON('order_date')] })).data));
  const u1 = await chart(D, byRegion(ORD, 'count'), { filters: [CTRL] });
  const u0 = await chart(D, byRegion(ORD, 'count'), { filters: [ON('order_date')] });
  ok('unset: byte-identical to today, no caption', JSON.stringify(u1.data) === JSON.stringify(u0.data) && JSON.stringify(u1.warnings) === JSON.stringify(u0.warnings) && u1.periodOn === undefined);
  ok('… the whole reply, byte for byte', JSON.stringify(u1) === JSON.stringify(u0), show([u1, u0]));
  const both = { category: 'region', values: [byRegion(REV).values[0], { column: 'amt', aggregation: 'count', metricId: ORD }] };
  const clash = await chart(D, both, { filters: [CTRL] });
  ok('two dates under a control: refused, naming both', clash.ok === false && /Revenue/.test(clash.error) && /Orders/.test(clash.error), show(clash));
  ok('… in the catalog\'s words', clash.error === msg.measuresCountByDifferentDates('Revenue', 'ship_date', 'Orders', msg.dashboardDate()), show(clash));
  ok('NEGATIVE CONTROL: the same chart with no control draws', (await chart(D, both)).ok === true);
  const settled = await chart(D, both, { filters: [{ ...CTRL, column: 'ship_date' }] });
  ok('measures by {none, ship_date} under a control already on ship_date draw: nothing moves', settled.ok === true && settled.periodOn === undefined, show(settled));
  ok('a tile\'s own date filter stays on its column', JSON.stringify((await chart(D, byRegion(REV), { filters: [CTRL, ON('order_date')] })).data) === JSON.stringify((await chart(D, byRegion(REV), { filters: [ON('ship_date'), ON('order_date')] })).data));
  const APRIL = { ...CTRL, column: 'ship_date', period: { preset: 'custom', from: '2024-04-01', to: '2024-04-30' } };
  const twoCtrl = await chart(D, byRegion(REV), { filters: [CTRL, APRIL] });
  ok('two date controls setting different periods on the metric\'s date: refused', twoCtrl.ok === false && twoCtrl.error === msg.controlPeriodsDisagree(), show(twoCtrl));
  ok('NEGATIVE CONTROL: the same controls over a metric with no date draw, each on its column', (await chart(D, byRegion(ORD, 'count'), { filters: [CTRL, APRIL] })).ok === true);

  // The pin: no mark, no read, the same filters in hand — so the door is given exactly what it was given before.
  const counted = async <T>(fn: () => Promise<T>): Promise<{ value: T; reads: number }> => {
    let reads = 0;
    const { getMetric } = metricsMod;
    const { getDatasetMeta } = H.datasets;
    Object.assign(metricsMod, { getMetric: (...x: Parameters<typeof getMetric>) => { reads += 1; return getMetric(...x); } });
    Object.assign(H.datasets, { getDatasetMeta: (...x: Parameters<typeof getDatasetMeta>) => { reads += 1; return getDatasetMeta(...x); } });
    try {
      return { value: await fn(), reads };
    } finally {
      Object.assign(metricsMod, { getMetric });
      Object.assign(H.datasets, { getDatasetMeta });
    }
  };
  const unmarked = [ON('order_date')] as never[];
  const pin = await counted(() => H.as(ORG_A, () => scope.chartScope(P, D, byRegion(REV) as never, unmarked)));
  ok('no mark: chartScope hands back the very same filters and reads nothing', pin.value.ok === true && pin.value.filters === unmarked && !('periodOn' in pin.value) && pin.reads === 0, show(pin));
  const marked = await counted(() => H.as(ORG_A, () => scope.chartScope(P, D, byRegion(REV) as never, [CTRL] as never[])));
  ok('NEGATIVE CONTROL: with a mark it reads the metric', marked.reads > 0);
  const plainReply = await chart(D, byRegion(REV), { filters: unmarked });
  ok('no mark: the reply has no periodOn key at all', plainReply.ok === true && !('periodOn' in plainReply), show(plainReply));
  const door = await H.as(ORG_A, () => ipcVisuals.vizDataFor(P, D, byRegion(REV) as never, [CTRL] as never[]));
  ok('the door itself (publish, stories) moves the period and says so', door.ok === true && door.periodOn === 'ship_date' && JSON.stringify(door.data) === JSON.stringify(a.data), show(door));

  const cmpA = await chart(D, { ...byRegion(REV), compare: { mode: 'previous_period' } }, { filters: [CTRL] });
  const cmpB = await chart(D, { ...byRegion(REV), compare: { mode: 'previous_period' } }, { filters: [ON('ship_date')] });
  ok('compare shifts the date the period landed on', cmpA.ok === true && cmpA.data.series.length === 2 && JSON.stringify(cmpA.data) === JSON.stringify(cmpB.data), show(cmpA));
  const FEB = { preset: 'custom', from: '2024-02-01', to: '2024-02-29' };
  const sorted = (r: Reply, i: number): string => JSON.stringify(r.data.labels.map((l: string, k: number) => [l, r.data.series[i].values[k]]).filter((p: unknown[]) => p[1] !== null).sort());
  const custom = await chart(D, { ...byRegion(REV), compare: { mode: 'custom', from: FEB.from, to: FEB.to } });
  const febShip = await chart(D, byRegion(REV), { filters: [{ type: 'filter', column: 'ship_date', op: 'period', period: FEB }] });
  const febOrder = await chart(D, byRegion(REV), { filters: [{ type: 'filter', column: 'order_date', op: 'period', period: FEB }] });
  ok('a custom compare with no date in scope lands on the metric\'s date', custom.ok === true && custom.data.series.length === 2 && sorted(custom, 1) === sorted(febShip, 0), show(custom));
  ok('NEGATIVE CONTROL: the first date column is a different figure', sorted(febShip, 0) !== sorted(febOrder, 0));
  const customPlain = await chart(D, { ...byRegion(ORD, 'count'), compare: { mode: 'custom', from: FEB.from, to: FEB.to } });
  const febOrderCount = await chart(D, byRegion(ORD, 'count'), { filters: [{ type: 'filter', column: 'order_date', op: 'period', period: FEB }] });
  ok('NEGATIVE CONTROL: a metric with no date keeps the first date column', sorted(customPlain, 1) === sorted(febOrderCount, 0));

  const drill = (await post('visual:rows', { projectId: P, datasetId: D, encoding: byRegion(REV), filters: [CTRL], mark: { category: 'West' } })).value;
  ok('drill rows use the metric\'s date', drill.ok === true && drill.filters.some((f: Reply) => f.column === 'ship_date' && f.op === 'period') && !drill.filters.some((f: Reply) => 'fromControl' in f), show(drill));
  const drillClash = (await post('visual:rows', { projectId: P, datasetId: D, encoding: both, filters: [CTRL], mark: { category: 'West' } })).value;
  ok('drill rows of a chart refused for two dates: no rows, the same sentence', drillClash.available === false && drillClash.reason === clash.error, show(drillClash));

  const Q1 = { ...CTRL, period: { preset: 'custom', from: '2024-01-01', to: '2024-03-31' } };
  const point = async (filters: unknown[]): Promise<Reply> => (await post('drivers:explainPoint', { projectId: P, datasetId: D, encoding: { category: 'order_date', grain: 'month', values: byRegion(REV).values }, filters, point: {} })).value;
  const pA = await point([Q1]);
  const pB = await point([{ ...Q1, column: 'ship_date', fromControl: undefined }]);
  const pC = await point([{ ...Q1, fromControl: undefined }]);
  ok('explain a point: the control lands on the metric\'s date', pA.ok === true && pA.bucket === pB.bucket && Object.is(pA.result.totals.a, pB.result.totals.a) && Object.is(pA.result.totals.b, pB.result.totals.b), show(pA));
  ok('NEGATIVE CONTROL: on the control\'s column it is another figure', pA.ok === true && pC.ok === true && !Object.is(pA.result.totals.a, pC.result.totals.a), show(pC));

  const explain = async (encoding: unknown): Promise<Reply> => (await post('answer:explain', { projectId: P, tile: { datasetId: D, encoding, filters: [CTRL], chartType: 'column', name: 'Revenue' } })).value;
  const ex = await explain(byRegion(REV));
  const exTurns = ex.ok ? (await post('copilot:history', { projectId: P, threadId: ex.threadId })).value.turns : [];
  const exSpec = exTurns.find((t: Reply) => t.answer)?.answer;
  ok('Explain on a tile under a control explains it, its period on the metric\'s date', ex.ok === true && !!exSpec && exSpec.filters.some((f: Reply) => f.column === 'ship_date') && !exSpec.filters.some((f: Reply) => f.column === 'order_date'), show([ex, exSpec]));
  const exClash = await explain(both);
  ok('Explain on a tile with two dates under a control: the chart\'s sentence, no conversation', exClash.ok === false && exClash.reason === clash.error && !exClash.threadId, show(exClash));

  const refLine = [{ id: 'r1', kind: 'reference', value: { type: 'metric', metricId: REV } }];
  const withRef = await chart(D, byRegion(ORD, 'count'), { filters: [CTRL], analytics: refLine });
  const kpi = async (filters: unknown[]): Promise<number | null | undefined> => (await H.as(ORG_A, () => ipcMetrics.resolveMetric(P, REV, { filters: filters as never[] })))?.value;
  const refValue = withRef.ok ? withRef.data.analytics?.[0]?.value : undefined;
  ok('a reference line\'s metric counts by its own date, not the chart\'s', typeof refValue === 'number' && Object.is(refValue, await kpi([ON('ship_date')])), show(withRef.data?.analytics));
  ok('NEGATIVE CONTROL: on the control\'s column it is another figure', !Object.is(refValue, await kpi([ON('order_date')])));

  const pivotOf = (id: string) => ({ category: 'region', values: [], pivot: { rows: [{ column: 'region' }], columns: [], values: byRegion(id).values, totals: { rows: true, columns: true, grand: true } } });
  const pv = await chart(D, pivotOf(REV), { filters: [CTRL] });
  ok('a pivot of a metric with its own date under a control on another column is refused, saying why', pv.ok === false && pv.error === msg.pivotOwnDate('Revenue'), show(pv));
  ok('NEGATIVE CONTROL: the same pivot with no control draws', (await chart(D, pivotOf(REV))).ok === true);
  ok('NEGATIVE CONTROL: … under a control on its own date', (await chart(D, pivotOf(REV), { filters: [{ ...CTRL, column: 'ship_date' }] })).ok === true);
  ok('NEGATIVE CONTROL: … and a pivot of a metric with no date under the control', (await chart(D, pivotOf(ORD), { filters: [CTRL] })).ok === true);

  // Formulas: one date for the formula and every part on its dataset, checked at draw time too (a part's date may move after the save).
  const agreed = await chart(D, byRegion((await save({ name: 'Agreed twice', definition: { formula: '[Revenue] * 2' } })).metric.id), { filters: [CTRL] });
  const agreedShip = await chart(D, { category: 'region', values: [{ column: 'amt', aggregation: 'sum' }] }, { filters: [ON('ship_date')] });
  ok('a formula whose parts share its date draws on it, and says so', agreed.ok === true && agreed.periodOn === 'ship_date' && agreed.data.series[0].values.every((v: number, k: number) => Object.is(v, agreedShip.data.series[0].values[agreedShip.data.labels.indexOf(agreed.data.labels[k])] * 2)), show(agreed));
  const stale = await chart(D, byRegion(DBL), { filters: [CTRL] }); // Double renamed counts by order_date; Revenue moved back to ship_date after it was saved
  ok('a formula whose part counts by another date is refused at draw time, naming both', stale.ok === false && stale.error === msg.formulaDatesDiffer('Double renamed', 'Revenue', 'ship_date', 'order_date'), show(stale));
  ok('NEGATIVE CONTROL: the same formula with no control draws', (await chart(D, byRegion(DBL))).ok === true);
  const RAW = (await H.as(ORG_A, () => metricsMod.saveMetric(P, { name: 'Raw twice', datasetId: D, definition: { formula: '[Shipped] * 2' } })))!.id; // saveMetric skips the date check
  const NEST = (await H.as(ORG_A, () => metricsMod.saveMetric(P, { name: 'Nested twice', datasetId: D, definition: { formula: '[Raw twice] + 1' } })))!.id;
  ok('a formula with no date over a dated part is refused under a control', (await chart(D, byRegion(RAW), { filters: [CTRL] })).error === msg.formulaDatesDiffer('Raw twice', 'Shipped', 'ship_date', msg.dashboardDate()));
  ok('… and so is a formula over that formula (the part of a part)', (await chart(D, byRegion(NEST), { filters: [CTRL] })).error === msg.formulaDatesDiffer('Nested twice', 'Shipped', 'ship_date', msg.dashboardDate()));
  ok('NEGATIVE CONTROL: under a control already on the part\'s date it draws', (await chart(D, byRegion(NEST), { filters: [{ ...CTRL, column: 'ship_date' }] })).ok === true);

  const lv = await hydrates(DL, () => chart(DL, byRegion(REVL), { filters: [CTRL] }));
  ok('Live: same figures as the extract, never hydrated', lv.hydrated === false && lv.value.ok === true && lv.value.periodOn === 'ship_date' && cmp.compareCharts(a.data, lv.value.data, () => true, false).length === 0, show(lv.value));

  // ── KPIs, their compare, the tree, alerts, the drivers, the Summary, what-ifs (Task 5) ─────────────
  const tile = async (metricId: string, filters: unknown[], compare?: unknown, datasetId = D): Promise<Reply> => (await post('analysis:tiles', { projectId: P, items: [{ kind: 'metric', metricId, datasetId, column: 'amt', aggregation: 'sum', filters, ...(compare ? { compare } : {}) }] })).value[0];
  const k1 = await tile(REV, [CTRL]);
  const kShip = await tile(REV, [ON('ship_date')]);
  ok('KPI: the control lands on the metric\'s date, and says so', typeof k1.value === 'number' && Object.is(k1.value, kShip.value) && k1.periodOn === 'ship_date', show([k1, kShip]));
  ok('NEGATIVE CONTROL: on the control\'s column it is another figure', !Object.is(k1.value, (await tile(REV, [ON('order_date')])).value));
  const kU = await tile(ORD, [CTRL]);
  const kU0 = await tile(ORD, [ON('order_date')]);
  ok('KPI unset: today\'s reply byte for byte, no caption', JSON.stringify(kU) === JSON.stringify(kU0) && !('periodOn' in kU), show([kU, kU0]));
  const cU = await tile(ORD, [CTRL], { mode: 'previous_year' });
  ok('… and its compare too', JSON.stringify(cU) === JSON.stringify(await tile(ORD, [ON('order_date')], { mode: 'previous_year' })), show(cU));
  ok('KPI: no mark, no periodOn key', !('periodOn' in kShip));
  const c1 = await tile(REV, [CTRL], { mode: 'previous_period' });
  const c0 = await tile(REV, [ON('ship_date')], { mode: 'previous_period' });
  ok('compare: the previous period on the metric\'s date', typeof c1.compare?.previous === 'number' && Object.is(c1.compare.previous, c0.compare.previous) && Object.is(c1.compare.value, k1.value), show([c1.compare, c0.compare]));
  ok('NEGATIVE CONTROL: on the control\'s column the previous period is another figure', !Object.is(c1.compare.previous, (await tile(REV, [ON('order_date')], { mode: 'previous_period' })).compare.previous));
  const feb = { type: 'filter', column: 'ship_date', op: 'period', period: FEB };
  const cc = await tile(REV, [], { mode: 'custom', from: FEB.from, to: FEB.to });
  ok('custom compare with nothing in scope uses the metric\'s date', typeof cc.compare?.previous === 'number' && Object.is(cc.compare.previous, (await tile(REV, [feb])).value), show(cc.compare));
  ok('NEGATIVE CONTROL: … the first date column is another figure', !Object.is(cc.compare.previous, (await tile(REV, [{ ...feb, column: 'order_date' }])).value));
  const kClash = await tile(REV, [CTRL, APRIL]);
  ok('KPI under two controls that disagree: no figure, the sentence, never the stored column\'s', kClash.ok === false && kClash.error === msg.controlPeriodsDisagree(), show(kClash));
  ok('NEGATIVE CONTROL: the compare under them is refused too', (await tile(REV, [CTRL, APRIL], { mode: 'previous_period' })).ok === false);
  const kStale = await tile(DBL, [CTRL]);
  ok('a formula whose part counts by another date: no figure, the sentence (F-8)', kStale.ok === false && kStale.error === msg.formulaDatesDiffer('Double renamed', 'Revenue', 'ship_date', 'order_date'), show(kStale));
  const idOf = async (name: string): Promise<string> => (await post('metric:list', { projectId: P })).value.metrics.find((m: Reply) => m.name === name).id;
  const kAgreed = await tile(await idOf('Agreed twice'), [CTRL]);
  ok('a formula whose parts share its date: the KPI on it', Object.is(kAgreed.value, k1.value * 2) && kAgreed.periodOn === 'ship_date', show(kAgreed));

  // A formula across datasets: each part counts by its own date (Revenue by ship_date, Target by month), compare too.
  const FM = { preset: 'custom', from: '2024-02-01', to: '2024-03-31' }; // Target: South's 90 in it, North's 100 in the 60 days before
  const shipFM = { ...feb, period: FM };
  const tFM = await tile(onX.metric.id, [{ ...CTRL, period: FM }], { mode: 'previous_period' });
  const revFM = await tile(REV, [shipFM], { mode: 'previous_period' });
  ok('a formula across datasets: each part counts by its own date', typeof revFM.value === 'number' && Object.is(tFM.value, revFM.value / 90) && tFM.periodOn === 'ship_date', show([tFM, revFM]));
  ok('… and its previous period too', Object.is(tFM.compare.previous, revFM.compare.previous / 100), show([tFM.compare, revFM.compare]));
  ok('NEGATIVE CONTROL: with no control the target is not narrowed', Object.is((await tile(onX.metric.id, [shipFM])).value, revFM.value / 190));

  const onOrderSum = (await post('dashboard:metric', { projectId: P, datasetId: D, column: 'amt', aggregation: 'sum', filters: [ON('order_date')] })).value;
  const tree = (await post('metricTree:compute', { projectId: P, id: REV, filters: [CTRL] })).value;
  ok('tree: the period is the control\'s, on the metric\'s date', tree.ok === true && tree.period.from === '2024-03-01' && Object.is(tree.root.current, k1.value), show(tree));
  const t0 = (await post('metricTree:compute', { projectId: P, id: REV })).value;
  ok('tree with no scope: its latest month is on the metric\'s date', t0.ok === true && Object.is(t0.root.current, (await tile(REV, [{ ...feb, period: { preset: 'custom', from: t0.period.from, to: t0.period.to } }])).value), show(t0));
  const tU = (await post('metricTree:compute', { projectId: P, id: ORD, filters: [CTRL] })).value;
  const tU0 = (await post('metricTree:compute', { projectId: P, id: ORD, filters: [ON('order_date')] })).value;
  ok('NEGATIVE CONTROL: a tree of a metric with no date is today\'s, byte for byte', JSON.stringify({ ...tU, tag: 0 }) === JSON.stringify({ ...tU0, tag: 0 }), show([tU, tU0]));
  const kids = [(await save({ name: 'Shipped amount', definition: SUM, timeColumn: 'ship_date' })).metric.id, (await save({ name: 'Placed amount', definition: SUM })).metric.id];
  const treeSaved = (await post('metricTree:save', { projectId: P, id: ORD, tree: { metricId: ORD, relation: 'sum', children: kids.map((metricId) => ({ metricId })) } })).value;
  const tKids = (await post('metricTree:compute', { projectId: P, id: ORD, filters: [CTRL] })).value;
  const shippedMarch = kShip.value;
  const placedMarch = onOrderSum.value;
  ok('tree: each node counts by its own date (F-14)', treeSaved.ok === true && tKids.ok === true && Object.is(tKids.root.children[0].current, shippedMarch) && Object.is(tKids.root.children[1].current, placedMarch) && Object.is(tKids.root.current, kU0.value), show([treeSaved, tKids.root]));
  ok('NEGATIVE CONTROL: the two dates are two figures', !Object.is(shippedMarch, placedMarch));
  await post('metricTree:save', { projectId: P, id: REV, tree: { metricId: REV, split: 'region' } });
  const tSplit = (await post('metricTree:compute', { projectId: P, id: REV, filters: [CTRL] })).value;
  ok('tree: a split\'s segments are on the metric\'s date too', tSplit.ok === true && tSplit.root.children.length === 4 && Object.is(tSplit.root.children.reduce((n: number, c: Reply) => n + c.current, 0), k1.value), show(tSplit.root));

  const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
  const rule = { id: '55555555-5555-4555-8555-555555555555', name: 'r', datasetId: D, metric: { column: 'amt', aggregation: 'sum', metricId: REV, filters: [CTRL] }, compare: 'threshold', threshold: { op: '<', value: 1 }, enabled: true };
  ok('an alert saved from the KPI counts the KPI\'s figure', Object.is((await H.as(ORG_A, () => alertStore.metricFor(P, rule as never))).value, k1.value));
  const bareRule = await H.as(ORG_A, () => alertStore.metricFor(P, { ...rule, metric: { ...rule.metric, metricId: undefined } } as never));
  const onOrder = (await post('dashboard:metric', { projectId: P, datasetId: D, column: 'amt', aggregation: 'sum', filters: [ON('order_date')] })).value;
  ok('NEGATIVE CONTROL: an alert on a bare column keeps the control\'s column', Object.is(bareRule.value, onOrder.value));
  ok('a bare column under a control: the mark is stripped, the figure today\'s', Object.is((await post('dashboard:metric', { projectId: P, datasetId: D, column: 'amt', aggregation: 'sum', filters: [CTRL] })).value.value, onOrder.value));
  ok('an alert under two controls that disagree reads no figure', (await H.as(ORG_A, () => alertStore.metricFor(P, { ...rule, metric: { ...rule.metric, filters: [CTRL, APRIL] } } as never))).value === null);

  const why = async (filters: unknown[], metricId = REV): Promise<Reply> => (await post('drivers:explain', { projectId: P, request: { datasetId: D, metric: { metricId }, filters, compare: { mode: 'previous_period' }, path: [] } })).value;
  const w1 = await why([CTRL]);
  const w0 = await why([ON('ship_date')]);
  ok('Why did this change: both periods on the metric\'s date', w1.ok === true && Object.is(w1.totals.a, k1.value) && Object.is(w1.totals.b, w0.totals.b) && w1.periods.column === 'ship_date', show([w1.totals, w0.totals]));
  ok('NEGATIVE CONTROL: … on the control\'s column it is another change', !Object.is(w1.totals.a, (await why([ON('order_date')])).totals.a));
  ok('… and two controls that disagree are refused with the sentence', (await why([CTRL, APRIL])).error === msg.controlPeriodsDisagree());
  const drivers: typeof import('../src/ipc/drivers') = require('../src/ipc/drivers');
  const dr = await H.as(ORG_A, () => drivers.driversFor(P, { datasetId: D, metric: { metricId: REV }, filters: [CTRL] as never[], compare: { mode: 'previous_period' }, path: [] }));
  ok('driversFor itself (the Summary, alerts, the waterfall): its question carries no mark', dr.ok === true && !JSON.stringify(dr.spec.filters).includes('fromControl') && Object.is(dr.totals.a, k1.value), show(dr));

  const summary: typeof import('../src/ipc/summary') = require('../src/ipc/summary');
  const sum = (filters: unknown[]) => H.as(ORG_A, () => summary.computeSummary(P, [{ cards: [{ type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: 'amt', aggregation: 'sum', metricId: REV } }] }], { filters: filters as never, params: new Map() }));
  const sm = (await sum([CTRL])).find((x) => x.kind === 'kpi');
  ok('Summary: the KPI sentence is the KPI\'s figure', !!sm && sm.figures.some((f) => Object.is(f.value, k1.value)), show(sm));

  const scenarios: typeof import('../src/analysis/scenarios') = require('../src/analysis/scenarios');
  const SC = (await H.as(ORG_A, () => scenarios.saveScenario(P, { name: 'Price up', baseMetricIds: [REV], drivers: [{ name: 'Price', kind: 'pct', value: 10, target: { column: 'amt' } }] } as never)))!.id;
  const whatIf = async (filters: unknown[]): Promise<Reply> => (await post('analysis:tiles', { projectId: P, items: [{ kind: 'metric', metricId: REV, datasetId: D, column: 'amt', aggregation: 'sum', scenarioId: SC, filters }] })).value[0].scenario;
  const s1 = await whatIf([CTRL]);
  const s0 = await whatIf([ON('ship_date')]);
  ok('a what-if: its baseline and its moved figure both on the metric\'s date', s1.ok === true && Object.is(s1.baseline, k1.value) && Object.is(s1.value, s0.value) && s1.value !== s1.baseline, show([s1, s0]));
  ok('NEGATIVE CONTROL: on the control\'s column the what-if is another figure', !Object.is(s1.value, (await whatIf([ON('order_date')])).value));

  const kDrill = (await post('visual:rows', { projectId: P, datasetId: D, encoding: { category: '', values: [{ column: 'amt', aggregation: 'sum' }] }, filters: [CTRL], metricId: REV })).value;
  ok('a KPI\'s rows are the rows of its own date (F-7)', kDrill.ok === true && kDrill.filters.some((f: Reply) => f.column === 'ship_date' && f.op === 'period') && !kDrill.filters.some((f: Reply) => f.column === 'order_date' || 'fromControl' in f), show(kDrill));

  const kl = await hydrates(DL, () => tile(REVL, [CTRL], undefined, DL));
  ok('Live KPI: the extract\'s figure on the metric\'s date, never hydrated', kl.hydrated === false && Object.is(kl.value.value, k1.value) && kl.value.periodOn === 'ship_date', show(kl.value));
  const klc = await hydrates(DL, () => tile(REVL, [CTRL], { mode: 'previous_period' }, DL));
  ok('Live KPI compare: the extract\'s previous period, never hydrated', klc.hydrated === false && Object.is(klc.value.compare.previous, c1.compare.previous), show(klc.value));

  await close();
  finish();
})().catch((err) => {
  ok('test-metricTimeDoors ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
