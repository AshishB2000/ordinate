// The date a metric counts by (semantic layer D9, PR 04), over the real RPC route. The harness of the whole PR:
// Task 3 saves and reads the date (below); the doors that rewrite a dashboard control's period onto it join it.
//
//   save      a column that is not a date is refused beside its field; a formula takes the date its parts share
//   datasets  a formula's parts are compared within one dataset only; an inherited date is a column of the formula's own
//   update    set, clear, and re-checked only when the patch can change the answer; a new definition re-takes its parts' date
//   read      the list carries it; a column that is gone is flagged by metric:get, counts as unset and blocks no edit
//   restore   a version brings the date back, or clears it
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

  await close();
  finish();
})().catch((err) => {
  ok('test-metricTimeDoors ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
