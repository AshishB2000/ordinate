// A snapshot metric (semantic layer D8, step 07): a stock count, a balance or a headcount is the value on the
// latest (or earliest) day in scope, not a sum over every day. Per date bucket on a chart by its own date, and
// over the whole scope otherwise (never per category).
//
// DIFFERENTIAL throughout: the door's figure (the KPI door, the chart door: resident, or the JS fallback they pick)
// against the row-level JS reference (analysis/snapshot.snapshotRows) folded by the ordinary engines, with Object.is.
// Whole-number figures, so DuckDB's parallel sum and a JS fold agree exactly.
//
//   store     the writer: the contract, the merge an old editor relies on, the words
//   pure      the reference and the helpers that pick a day
//   kpi       the KPI door against the reference, resident, an empty scope, a refresh
//   chart     the chart door per bucket and over the scope, and what it refuses
//   surfaces  alerts, answer cards, scenarios
//   facts     what the Assistant and agents are told
//
//   npm run build:ts && node scripts/test-snapshot.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-snapshot-'));

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const snap: typeof import('../src/analysis/snapshot') = require('../src/analysis/snapshot');
const { metrics: api }: typeof import('../src/api/metrics') = require('../src/api/metrics');
const { describeDefinition }: typeof import('../src/analysis/metricFormat') = require('../src/analysis/metricFormat');
const { civilFromDays }: typeof import('../src/analysis/civilDays') = require('../src/analysis/civilDays');
const { periodDay }: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const { computeMetric }: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const { buildVizData }: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const { dateBucket, parseDateCell }: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const ipcAnswers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const scenarioResolve: typeof import('../src/analysis/scenarioResolve') = require('../src/analysis/scenarioResolve');
const scenarioModel: typeof import('../src/analysis/scenarioModel') = require('../src/analysis/scenarioModel');
const { validateAnswerSpec }: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
type AlertRule = import('../src/analysis/alerts').AlertRule;
const { metricLines }: typeof import('../src/ai/copilotFacts') = require('../src/ai/copilotFacts');
const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const { followedMeasureTexts }: typeof import('../src/ipc/copilotMeasures') = require('../src/ipc/copilotMeasures');
type Metric = import('../src/analysis/metrics').Metric;
type FilterStep = import('../src/data/transforms').FilterStep;

type Any = any; // any: each handler's own reply shape, read field by field below
const show = (v: unknown): string => String(JSON.stringify(v)).slice(0, 600);
const pad = (n: number): string => String(n).padStart(2, '0');
const isoFromDays = (z: number): string => { const c = civilFromDays(z); return `${c.y}-${pad(c.m)}-${pad(c.d)}`; };
const usFromDays = (z: number): string => { const c = civilFromDays(z); return `${pad(c.m)}/${pad(c.d)}/${c.y}`; };

// ── The STOCK fixture ────────────────────────────────────────────────────────
// Every second day from 2023-01-01 for 420 days, three regions × two skus. `day` is ISO on even rows and US on odd
// ones, so every day carries both spellings. West stops 10 days before the end. Some units are empty, and twelve
// rows have no day at all.
const COLS = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'sku', type: 'text' }, { name: 'units', type: 'number' }, { name: 'counted', type: 'date' }] as Any;
const START = periodDay('2023-01-01')!;
const REGIONS = ['East', 'North', 'West'];
const SKUS = ['A', 'B'];
const ROWS: Array<[string, string, string, number | null, string]> = [];
for (let d = 0; d < 420; d += 2) {
  REGIONS.forEach((region, r) => {
    if (region === 'West' && d > 418 - 10) return;
    SKUS.forEach((sku, s) => {
      const day = START + d;
      ROWS.push([ROWS.length % 2 ? usFromDays(day) : isoFromDays(day), region, sku, (d + r) % 17 === 0 ? null : (d * 7 + r * 13 + s * 5) % 50, isoFromDays(day + 1)]);
    });
  });
}
for (let i = 0; i < 12; i += 1) ROWS.push(['', REGIONS[i % 3], SKUS[i % 2], 7, '']);
const LAST = Math.max(...ROWS.map((r) => periodDay(r[0]) ?? -Infinity));
const LAST_SPELLINGS = new Set(ROWS.filter((r) => periodDay(r[0]) === LAST).map((r) => r[0]));
const S = { column: 'day', take: 'last' };

void (async () => {
  await projects.init();
  ipcVisuals.register();
  ipcMetrics.register();
  const pid = (await projects.createProject('Snapshot')).id;
  const ds = (await datasets.saveDataset(pid, { name: 'Stock', sourceKind: 'csv', columns: COLS, rows: ROWS } as Any))!.id;
  const save = (input: object) => handlers.get('metric:save')!(null, { projectId: pid, input: { datasetId: ds, format: { kind: 'number' }, ...input } });
  const update = (id: string, patch: object) => handlers.get('metric:update')!(null, { projectId: pid, id, patch });

  // ── store ──────────────────────────────────────────────────────────────────
  ok('fixture: above the resident threshold, and both spellings on the last day', ROWS.length > 1_000 && LAST_SPELLINGS.size === 2, show([ROWS.length, [...LAST_SPELLINGS]]));
  ok('contract: save takes a snapshot', api['metric:save'].input.safeParse({ projectId: pid, input: { name: 'S', datasetId: ds, definition: { column: 'units', aggregation: 'sum', snapshot: S } } }).success);
  ok('contract: update takes snapshot: null', api['metric:update'].input.safeParse({ projectId: pid, id: ds, patch: { definition: { column: 'units', aggregation: 'sum', snapshot: null } } }).success);
  ok('contract: take is last or first', !api['metric:preview'].input.safeParse({ projectId: pid, datasetId: ds, definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'max' } } }).success);
  ok('contract: a formula takes none', !api['metric:save'].input.safeParse({ projectId: pid, input: { name: 'S', datasetId: ds, definition: { formula: '[A]', snapshot: S } } }).success);
  const r = await save({ name: 'Draft', definition: { column: 'units', aggregation: 'sum', snapshot: S } });
  ok('saved with its snapshot', r.ok && isDeepStrictEqual(r.metric.definition.snapshot, S), show(r));
  const bad = await save({ name: 'Bad', definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'region', take: 'last' } } });
  ok('a text column is refused beside the field', bad.ok === false && bad.field === 'snapshot' && bad.error === msg.snapshotNotDate('region'), show(bad));
  const badUpdate = await update(r.metric.id, { definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'sku', take: 'last' } } });
  ok('…and on update', badUpdate.ok === false && badUpdate.field === 'snapshot' && badUpdate.error === msg.snapshotNotDate('sku'), show(badUpdate));
  ok('NEGATIVE CONTROL: a plain metric saves with no snapshot check', (await save({ name: 'Plain check', definition: { column: 'units', aggregation: 'sum' } })).ok === true);
  await update(r.metric.id, { definition: { column: 'units', aggregation: 'avg' } });
  ok('an editor that knows no snapshot keeps it', isDeepStrictEqual((await metrics.getMetric(pid, r.metric.id))!.definition, { column: 'units', aggregation: 'avg', snapshot: S }));
  await update(r.metric.id, { definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'first' } } });
  ok('words', describeDefinition((await metrics.getMetric(pid, r.metric.id))!) === 'sum of units, on the earliest day', describeDefinition((await metrics.getMetric(pid, r.metric.id))!));
  await update(r.metric.id, { definition: { column: 'units', aggregation: 'sum', snapshot: null } });
  ok('null clears it, byte-identical to a plain metric', JSON.stringify((await metrics.getMetric(pid, r.metric.id))!.definition) === '{"column":"units","aggregation":"sum"}');
  ok('NEGATIVE CONTROL: a plain metric\'s words are today\'s', describeDefinition((await metrics.getMetric(pid, r.metric.id))!) === 'sum of units');

  // ── pure ───────────────────────────────────────────────────────────────────
  const C = [{ name: 'day', type: 'date' }, { name: 'units', type: 'number' }] as Any;
  const R = [['2024-03-30', 1], ['03/31/2024', 2], ['2024-03-31', 3], ['', 9], ['2024-04-02', 4]];
  ok('latest day: only 2024-04-02', isDeepStrictEqual(snap.snapshotRows(C, R, { column: 'day', take: 'last' }), [['2024-04-02', 4]]));
  ok('latest per month: 31 March twice, 2 April once', isDeepStrictEqual(snap.snapshotRows(C, R, { column: 'day', take: 'last' }, (row) => (String(row[0]).includes('03') ? 'm3' : 'm4')), [['03/31/2024', 2], ['2024-03-31', 3], ['2024-04-02', 4]]));
  ok('earliest day: 30 March', isDeepStrictEqual(snap.snapshotRows(C, R, { column: 'day', take: 'first' }), [['2024-03-30', 1]]));
  ok('an undated row is never kept', !snap.snapshotRows(C, R, { column: 'day', take: 'first' }).some((row) => row[0] === ''));
  ok('a column the table lacks keeps no row', snap.snapshotRows(C, R, { column: 'gone', take: 'last' }).length === 0);
  ok('latestDay', snap.latestDay(['2024-01-02', '', '2024-01-09', 'Other'], 'last') === '2024-01-09' && snap.latestDay(['2024-01-02', '2024-01-09'], 'first') === '2024-01-02' && snap.latestDay([], 'last') === null);
  const day = { labels: ['2024-01-30', '2024-01-31', '2024-02-03'], series: [{ name: 'East', values: [5, null, 7] }, { name: 'West', values: [1, 2, null] }] };
  ok('per month: each bucket\'s latest day, never an older value', isDeepStrictEqual(snap.pickPerBucket(day, 'month', 'last'), { labels: ['2024-01', '2024-02'], series: [{ name: 'East', values: [null, 7] }, { name: 'West', values: [2, null] }] }), show(snap.pickPerBucket(day, 'month', 'last')));
  ok('per month, earliest: each bucket\'s first day', isDeepStrictEqual(snap.pickPerBucket(day, 'month', 'first'), { labels: ['2024-01', '2024-02'], series: [{ name: 'East', values: [5, 7] }, { name: 'West', values: [1, null] }] }));
  ok('a label that is no day is skipped', isDeepStrictEqual(snap.pickPerBucket({ labels: ['', '2024-01-02'], series: [{ name: 'x', values: [9, 1] }] }, 'year', 'last'), { labels: ['2024'], series: [{ name: 'x', values: [1] }] }));
  ok('onDay', isDeepStrictEqual(snap.onDay('day', '2024-01-31'), { type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-01-31', to: '2024-01-31' } }));

  // ── kpi ────────────────────────────────────────────────────────────────────
  const saved = async (name: string, definition: object, filters: object[] = []): Promise<Metric> => {
    const res = await save({ name, definition, filters });
    if (!res.ok) throw new Error(`"${name}" not saved: ${show(res)}`);
    return res.metric as Metric;
  };
  const stock = await saved('Stock', { column: 'units', aggregation: 'sum', snapshot: S });
  const opening = await saved('Opening', { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'first' } });
  const lines = await saved('Lines', { column: 'units', aggregation: 'count', snapshot: S });
  const level = await saved('Level', { column: 'units', aggregation: 'avg', snapshot: S });
  const peak = await saved('Peak', { column: 'units', aggregation: 'max', snapshot: S });
  const eastStock = await saved('East stock', { column: 'units', aggregation: 'sum', snapshot: S }, [{ type: 'filter', column: 'region', op: '=', value: 'East' }]);
  const units = await saved('Units', { column: 'units', aggregation: 'sum' });
  const double = await saved('Double stock', { formula: '[Stock] * 2' });
  const snapOf = (m: Metric) => (m.definition as { snapshot: import('../src/analysis/snapshot').MetricSnapshot }).snapshot;
  const kpi = async (m: Metric, scope: FilterStep[]) => (await ipcMetrics.resolveMetric(pid, m.id, { filters: scope }))!.value;
  const table = (f: FilterStep[]) => transforms.applyPipeline({ columns: COLS, rows: ROWS }, f);
  const ref = (m: Metric, scope: FilterStep[]) => {
    const t = table(m.filters.concat(scope));
    return computeMetric(t.columns, snap.snapshotRows(t.columns, t.rows, snapOf(m)), m.definition as Any);
  };
  const SPRING = [{ type: 'filter', column: 'region', op: 'in', values: ['East', 'West'] }, { type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2023-03-01', to: '2023-06-30' } }] as FilterStep[];
  const NONE = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '1999-01-01', to: '1999-12-31' } }] as FilterStep[];
  const t0 = trace.snapshot();
  for (const m of [stock, opening, lines, level, peak, eastStock]) {
    for (const [name, scope] of [['no scope', []], ['East and West in spring', SPRING], ['nothing in scope', NONE]] as Array<[string, FilterStep[]]>) {
      const got = await kpi(m, scope);
      const want = ref(m, scope);
      ok(`kpi ${m.name}, ${name}: door = reference (Object.is)`, Object.is(got, want), show([got, want]));
    }
  }
  const t1 = trace.snapshot();
  ok('resident: the day list and the figure ran in place', (t1.vizAggregate?.resident ?? 0) > (t0.vizAggregate?.resident ?? 0) && (t1.metric?.resident ?? 0) > (t0.metric?.resident ?? 0), show([t0.vizAggregate, t1.vizAggregate, t0.metric, t1.metric]));
  ok('empty scope: count 0, sum null', (await kpi(lines, NONE)) === 0 && (await kpi(stock, NONE)) === null);
  ok('a real figure, not an empty one', typeof (await kpi(stock, [])) === 'number' && typeof (await kpi(stock, SPRING)) === 'number');
  ok('NEGATIVE CONTROL: not the sum over every date', (await kpi(stock, [])) !== (await kpi(units, [])));
  ok('NEGATIVE CONTROL: earliest ≠ latest', (await kpi(opening, [])) !== (await kpi(stock, [])));

  // The same rows with every third day spelled "Mar 5, 2024" (parse.looksLikeDate declares it a date, and a date axis
  // reads it): the day filter keeps the rows the axis put on that day, so every figure is the canonical table's.
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const LONG = ROWS.map((row, i) => { const c = civilFromDays(periodDay(row[0]) ?? 0); return i % 3 === 0 && row[0] ? [`${MON[c.m - 1]} ${c.d}, ${c.y}`, ...row.slice(1)] : row; });
  const dsLong = (await datasets.saveDataset(pid, { name: 'Stock, long days', sourceKind: 'csv', columns: COLS, rows: LONG } as Any))!.id;
  ok('long fixture: the latest day carries the long spelling', LONG.some((row) => /^[A-Z][a-z]{2} \d/.test(String(row[0])) && parseDateCell(row[0] as string) && Object.is(periodDay(ROWS[LONG.indexOf(row)][0]), LAST)));
  const CTRL = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2023-03-01', to: '2023-06-30' }, fromControl: true }] as FilterStep[];
  for (const m of [stock, opening, lines, level, eastStock, units]) {
    const res = await save({ name: `${m.name} (long)`, datasetId: dsLong, definition: m.definition, filters: m.filters });
    for (const [name, scope] of [['no scope', []], ['East and West in spring', SPRING], ['a date control', CTRL], ['nothing in scope', NONE]] as Array<[string, FilterStep[]]>) {
      const got = await kpi(res.metric, scope);
      const t = transforms.applyPipeline({ columns: COLS, rows: LONG }, m.filters.concat(scope));
      const want = 'snapshot' in m.definition ? computeMetric(t.columns, snap.snapshotRows(t.columns, t.rows, snapOf(m)), m.definition as Any) : computeMetric(t.columns, t.rows, m.definition as Any);
      ok(`long days: kpi ${m.name}, ${name}: door = reference = the canonical table's (Object.is)`, Object.is(got, want) && Object.is(got, await kpi(m, scope)), show([got, want, await kpi(m, scope)]));
    }
  }
  const longBy = (category: string) => handlers.get('visual:data')!(null, { projectId: pid, datasetId: dsLong, encoding: { category, values: [{ column: 'units', aggregation: 'sum' }] }, filters: CTRL });
  const canonBy = (category: string) => handlers.get('visual:data')!(null, { projectId: pid, datasetId: ds, encoding: { category, values: [{ column: 'units', aggregation: 'sum' }] }, filters: CTRL });
  ok('long days: a date control keeps the long-spelled rows (chart by region = the canonical table\'s)', isDeepStrictEqual((await longBy('region')).data, (await canonBy('region')).data), show([await longBy('region'), await canonBy('region')]));
  ok('both spellings on the latest day count', (await kpi(lines, [])) === ROWS.filter((row) => periodDay(row[0]) === LAST && typeof row[3] === 'number').length);
  ok('a formula over it: [Stock] * 2', Object.is(await kpi(double, []), 2 * (await kpi(stock, []))!));
  ok('the editor\'s preview of an unsaved snapshot is its figure', (await ipcMetrics.previewDefinition(pid, ds, { column: 'units', aggregation: 'sum', snapshot: S }, [], { kind: 'number' })).value === (await kpi(stock, [])));
  await datasets.updateDatasetData(pid, ds, { columns: COLS, rows: ROWS.concat([[isoFromDays(LAST + 2), 'East', 'A', 41, isoFromDays(LAST + 3)]]) } as Any); // a refresh adds a later day
  ok('a later day after refresh → that day\'s figure, not a cached old one', (await kpi(stock, [])) === 41);
  await datasets.updateDatasetData(pid, ds, { columns: COLS, rows: ROWS } as Any); // back, for the sections below
  ok('…and back', Object.is(await kpi(stock, []), ref(stock, [])));

  // ── chart ──────────────────────────────────────────────────────────────────
  const viz = handlers.get('visual:data')!;
  const chart = (encoding: object, filters: object[] = []): Promise<Any> => viz(null, { projectId: pid, datasetId: ds, encoding, filters });
  const M = (m: Metric) => ({ column: m.name, aggregation: (m.definition as { aggregation: string }).aggregation, metricId: m.id });
  const sameItems = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const refChart = (enc: Any, m: Metric, f: FilterStep[]) => {
    const t = table(m.filters.concat(f));
    const part = enc.category === 'day' ? (row: unknown[]) => { const c = parseDateCell(row[0] as string); return c ? String(dateBucket(c, enc.grain)) : null; } : undefined;
    return buildVizData(t.columns, snap.snapshotRows(t.columns, t.rows, snapOf(m), part as Any), { ...enc, values: [{ column: 'units', aggregation: (m.definition as Any).aggregation }] }, []);
  };
  const c0 = trace.snapshot();
  for (const [name, enc, m, f] of [
    ['by month', { category: 'day', grain: 'month', values: [M(stock)] }, stock, []],
    ['by quarter, earliest', { category: 'day', grain: 'quarter', values: [M(opening)] }, opening, []],
    ['by week, average', { category: 'day', grain: 'week', values: [M(level)] }, level, []],
    ['by region', { category: 'region', values: [M(stock)] }, stock, []],
    ['by sku, a count', { category: 'sku', values: [M(lines)] }, lines, []],
    ['by month × region', { category: 'day', grain: 'month', series: 'region', values: [M(stock)] }, stock, []],
    ['by region × sku', { category: 'region', series: 'sku', values: [M(peak)] }, peak, []],
    ['by month, filtered', { category: 'day', grain: 'month', values: [M(eastStock)] }, eastStock, [{ type: 'filter', column: 'sku', op: '=', value: 'A' }]],
    ['by region, in spring', { category: 'region', values: [M(stock)] }, stock, SPRING],
    ['by region, nothing in scope', { category: 'region', values: [M(stock)] }, stock, NONE],
    ['by month, nothing in scope', { category: 'day', grain: 'month', values: [M(stock)] }, stock, NONE],
  ] as Array<[string, Any, Metric, FilterStep[]]>) {
    const got = await chart(enc, f);
    const want = refChart(enc, m, f);
    ok(`${name}: labels = reference`, got.ok && sameItems(got.data.labels, want.data.labels), show([got, want.data]));
    // By series NAME under a split: the door's day grid can carry a series with no kept row (all null) that the reference never sees.
    const gotOf = (sr: { name: string }, i: number) => (enc.series ? got.data.series.find((g: Any) => g.name === sr.name) : got.data.series[i]);
    ok(`${name}: every cell = reference (Object.is)`, got.ok && want.data.series.every((sr, i) => !!gotOf(sr, i) && sameItems(gotOf(sr, i)!.values, sr.values))
      && (!enc.series || got.data.series.filter((g: Any) => !want.data.series.some((sr) => sr.name === g.name)).every((g: Any) => g.values.every((v: unknown) => v === null))), show([got.data, want.data]));
  }
  ok('resident: the chart\'s questions ran in place', (trace.snapshot().vizAggregate?.resident ?? 0) > (c0.vizAggregate?.resident ?? 0));
  const byRegion = await chart({ category: 'region', values: [M(stock)] });
  ok('West, with no row on the latest day, has no bar — not its older value', byRegion.ok && !byRegion.data.labels.includes('West') && byRegion.data.labels.includes('East'), show(byRegion));
  const two = await chart({ category: 'region', values: [M(stock), { column: 'units', aggregation: 'sum' }] });
  const w = two.ok ? two.data.labels.indexOf('West') : -1;
  ok('beside a plain measure, West is an empty cell', w >= 0 && two.data.series[0].values[w] === null && typeof two.data.series[1].values[w] === 'number', show(two));
  ok('…and the other cells are the snapshot\'s', two.ok && byRegion.data.labels.every((l: string, i: number) => Object.is(two.data.series[0].values[two.data.labels.indexOf(l)], byRegion.data.series[0].values[i])));
  const twoSnaps = await chart({ category: 'region', values: [M(stock), M(opening)] });
  ok('two snapshots with no filters are still two questions (latest ≠ earliest)', twoSnaps.ok && !sameItems(twoSnaps.data.series[0].values, twoSnaps.data.series[1].values), show(twoSnaps));
  const auto = await chart({ category: 'day', values: [M(stock)] });
  const plainAuto = await chart({ category: 'day', values: [{ column: 'units', aggregation: 'sum' }] });
  ok('auto grain is the plain chart\'s', auto.ok && plainAuto.ok && auto.category?.grain === plainAuto.category?.grain && sameItems(auto.data.labels, plainAuto.data.labels.filter((l: string) => l !== '')), show([auto.category, plainAuto.category]));
  ok('NEGATIVE CONTROL: the plain chart by month is not the snapshot\'s', !sameItems((await chart({ category: 'day', grain: 'month', values: [{ column: 'units', aggregation: 'sum' }] })).data.series[0].values, (await chart({ category: 'day', grain: 'month', values: [M(stock)] })).data.series[0].values));
  const other = await chart({ category: 'counted', grain: 'month', values: [M(stock)] });
  ok('a chart by another date is refused, naming both', other.ok === false && other.error === msg.snapshotOtherDate('Stock', 'day', 'counted'), show(other));
  ok('NEGATIVE CONTROL: the same chart of a plain metric draws', (await chart({ category: 'counted', grain: 'month', values: [M(units)] })).ok === true);
  const piv = await chart({ category: 'region', values: [M(stock)], pivot: { rows: [{ column: 'region' }], columns: [], values: [M(stock)] } });
  ok('a pivot is refused', piv.ok === false && piv.error === msg.snapshotInPivot('Stock'), show(piv));
  ok('NEGATIVE CONTROL: the same pivot of a plain metric draws', (await chart({ category: 'region', values: [M(units)], pivot: { rows: [{ column: 'region' }], columns: [], values: [M(units)] } })).ok === true);
  const rt = await chart({ category: 'day', grain: 'month', values: [{ ...M(stock), calc: { kind: 'running_total', along: 'across' } }] });
  ok('step 02 end to end: running total along months refused (time)', rt.ok === false && rt.error === msg.calcNotAdditiveOverTime('Stock', 'a running total'), show(rt));
  ok('…and percent of total across regions allowed', (await chart({ category: 'region', values: [{ ...M(stock), calc: { kind: 'pct_of_total', along: 'across' } }] })).ok === true);
  const dbl = await chart({ category: 'region', values: [M(double)] });
  ok('a formula over it per cell: [Stock] * 2', dbl.ok && sameItems(dbl.data.labels, byRegion.data.labels) && dbl.data.series[0].values.every((v: number | null, i: number) => Object.is(v, byRegion.data.series[0].values[i] === null ? null : 2 * byRegion.data.series[0].values[i])), show(dbl));
  const binned = await chart({ category: 'units', values: [M(stock), { column: 'units', aggregation: 'count' }] });
  ok('a binned axis beside a plain measure is refused: two questions, two bin plans', binned.ok === false && binned.error === msg.measureNeedsOneAxis('sum of units'), show(binned));
  ok('NEGATIVE CONTROL: the snapshot alone on that axis draws, binned over its own day', (await chart({ category: 'units', values: [M(stock)] })).ok === true);
  const facet = await chart({ category: 'region', values: [M(stock)], facet: { cols: 'sku' } });
  ok('small multiples of a snapshot are refused (one question per facet cannot be lined up)', facet.ok === false && facet.error === msg.measureNoFacets(), show(facet));

  // ── surfaces ───────────────────────────────────────────────────────────────
  const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const rule = (metric: object, extra: object = {}) => ({ id: U(1), name: 'r', datasetId: ds, metric, compare: 'threshold', threshold: { op: '>', value: 0 }, enabled: true, ...extra }) as never as AlertRule;
  ok('an alert on Stock watches the snapshot', (await alertStore.metricFor(pid, rule({ column: 'units', aggregation: 'sum', metricId: stock.id }))).value === (await kpi(stock, [])));
  ok('NEGATIVE CONTROL: an alert on the bare column is the plain sum', (await alertStore.metricFor(pid, rule({ column: 'units', aggregation: 'sum' }))).value === (await kpi(units, [])));
  const change = await alertStore.metricFor(pid, rule({ column: 'units', aggregation: 'sum', metricId: stock.id }, { compare: 'change', threshold: undefined, change: { pct: 10, direction: 'either', vs: 'previous_period', periodColumn: 'day' } }));
  const periods = (await alertStore.recentPeriods(pid, ds, 'day'))!;
  const inPeriod = (key: string) => [{ type: 'filter', column: 'day', op: periods.op, value: key }] as FilterStep[];
  ok('a previous-period alert reads each period\'s own last day (reference, Object.is)', typeof change.value === 'number' && Object.is(change.value, ref(stock, inPeriod(periods.keys[1]))) && Object.is(change.previous, ref(stock, inPeriod(periods.keys[0]))), show([change, periods]));
  const sm = await ipcAnswers.specMetrics(pid);
  ok('an answer card never treats Stock as a bare column', sm.find((x) => x.id === stock.id)?.hasFilters === true && sm.find((x) => x.id === units.id)?.hasFilters === false, show(sm.filter((x) => [stock.id, units.id].includes(x.id))));
  const named = (id: string) => validateAnswerSpec({ dataset: ds, category: 'region', measures: [id === stock.id ? 'Stock' : 'Units'] }, [{ id: ds, name: 'Stock data', columns: COLS }], { metrics: sm });
  ok('…so a spec naming it is refused, never drawn as a sum of units', !named(stock.id).ok, show(named(stock.id)));
  ok('NEGATIVE CONTROL: a spec naming a plain metric takes it', named(units.id).ok, show(named(units.id)));
  const sc = await scenarioResolve.computeScenario(pid, { id: U(2), name: 't', baseMetricIds: [stock.id], drivers: scenarioModel.sanitizeDrivers([{ kind: 'pct', target: { column: 'units' }, value: 5 }]) });
  ok('a scenario says its drivers were not applied, and keeps the baseline', sc.ok && sc.notes.includes('Drivers on "units" were not applied to a snapshot metric.') && sc.metrics[0].value === (await kpi(stock, [])) && sc.metrics[0].baseline === sc.metrics[0].value, show(sc));
  const scPlain = await scenarioResolve.computeScenario(pid, { id: U(3), name: 't', baseMetricIds: [units.id], drivers: scenarioModel.sanitizeDrivers([{ kind: 'pct', target: { column: 'units' }, value: 5 }]) });
  ok('NEGATIVE CONTROL: the same driver moves a plain metric, with no such note', scPlain.ok && (scPlain.metrics[0].value as number) > (scPlain.metrics[0].baseline as number) && !scPlain.notes.some((n: string) => n.includes('snapshot')), show(scPlain));

  // ── facts ──────────────────────────────────────────────────────────────────
  const said = (m: object): string => { const lines: string[] = []; metricLines(lines, [], [{ name: 'Balance', definitionText: 'sum of amount', value: 5, display: '5', ...m }]); return lines.join('\n'); };
  ok('the Assistant is told a snapshot is its latest day\'s value', said({ snapshot: { column: 'as_of', take: 'last' } }).includes('Snapshot: the value on the latest as_of in the period, not a sum over dates.'), said({ snapshot: { column: 'as_of', take: 'last' } }));
  ok('…or its earliest', said({ snapshot: { column: 'as_of', take: 'first' } }).includes('Snapshot: the value on the earliest as_of in the period, not a sum over dates.'));
  ok('NEGATIVE CONTROL: a plain metric gets no such sentence', !said({}).includes('Snapshot'));
  const listed = (await automation.metricsList({ projectId: pid } as never)) as Array<{ id: string; snapshot: unknown; definition: string }>;
  ok('list_metrics carries the stored snapshot', isDeepStrictEqual(listed.find((x) => x.id === stock.id)?.snapshot, S) && listed.find((x) => x.id === stock.id)?.definition === 'sum of units, on the latest day', show(listed.find((x) => x.id === stock.id)));
  ok('NEGATIVE CONTROL: …and null for a plain metric', listed.find((x) => x.id === units.id)?.snapshot === null);
  const lineOf = async (m: Metric) => (await followedMeasureTexts(pid, ds, { category: 'region', values: [M(m)] } as Any, {}))[0];
  ok('a chart\'s facts name the snapshot, never a bare sum(units)', (await lineOf(stock)) === '"Stock" = sum(units) on the latest day', show(await lineOf(stock)));
  ok('…with its filters too', (await lineOf(eastStock)) === '"East stock" = sum(units) on the latest day where region = "East"', show(await lineOf(eastStock)));
  ok('NEGATIVE CONTROL: a plain metric\'s chart line is the bare measure', (await lineOf(units)) === undefined);
  const gone = (await metrics.saveMetric(pid, { name: 'Gone day', datasetId: ds, definition: { column: 'units', aggregation: 'count', snapshot: { column: 'removed', take: 'last' } } }))!;
  ok('a snapshot day column that is gone gives no figure, never a count of 0', (await ipcMetrics.resolveMetric(pid, gone.id))!.value === null);
  ok('NEGATIVE CONTROL: the same count on the real day column is a figure', (await kpi(lines, [])) !== null && (await kpi(lines, [])) !== 0);

  finish();
})().catch((err) => {
  ok('test-snapshot ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
