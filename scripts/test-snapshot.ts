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

type Any = any; // any: each handler's own reply shape, read field by field below
const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);
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
  const r = await save({ name: 'Stock', definition: { column: 'units', aggregation: 'sum', snapshot: S } });
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

  finish();
})().catch((err) => {
  ok('test-snapshot ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
