// Key drivers — the decomposition, its shapes and scopes, and the whole path
// end to end against a real (temporary) project store.
//
//   1. shapes      which metrics split into members, and how: sum, count, avg,
//                  formulas over metrics and totals, operand filters, refusals
//   2. additive    the member changes sum EXACTLY to the delta; the waterfall
//                  closes; "Other" is the rest; explained variance behaves
//   3. ratio       mix + rate = each member's contribution, and the effects sum
//                  to the ratio's change; a member in one period only is mix
//   4. ranking     stable on ties (column order), whatever order groups arrive
//   5. scopes      KPI Compare, a chart bucket, labels, the drill path
//   6. end to end  driversFor on a saved dataset: totals equal the metrics
//                  layer's own figures, resident ≡ JS, no hydration when
//                  resident, the caption, the facts ledger, the tile, "latest"
//
//   npm run build:ts && node scripts/test-drivers.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-drivers-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_n: string) => tmp, getVersion: () => '0.0.0-test', getAppPath: () => path.resolve(__dirname, '..') },
      ipcMain: { handle: () => {}, on: () => {} },
      net: {}, nativeImage: {}, shell: {}, dialog: {}, BrowserWindow: { getAllWindows: () => [] },
      Notification: function () { return { show: () => {} }; },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const shapeMod: typeof import('../src/analysis/driverShape') = require('../src/analysis/driverShape');
const drv: typeof import('../src/analysis/drivers') = require('../src/analysis/drivers');
const scope: typeof import('../src/analysis/driverScope') = require('../src/analysis/driverScope');
const ipc: typeof import('../src/ipc/drivers') = require('../src/ipc/drivers');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const metricsIpc: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const copilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const audit: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');

type Shape = import('../src/analysis/driverShape').DriverShape;
type Metric = import('../src/analysis/metrics').Metric;

const close = (a: unknown, b: number, eps = 1e-12): boolean => typeof a === 'number' && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const COLS = [
  { name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'state', type: 'text' },
  { name: 'category', type: 'text' }, { name: 'revenue', type: 'number' }, { name: 'profit', type: 'number' },
  { name: 'cost', type: 'number' }, { name: 'refund', type: 'text' }, { name: 'mon', type: 'text' },
] as import('../src/data/parse').ParsedColumn[];

function metric(name: string, definition: any, filters: any[] = [], datasetId = 'D'): Metric {
  return {
    id: name, projectId: 'P', name, datasetId, definition, filters,
    format: { kind: 'number', decimals: 0, compact: false }, createdAt: '', updatedAt: '', schemaVersion: 1,
  } as Metric;
}

// ── 1. shapes ────────────────────────────────────────────────────────────────

function shapeChecks(): void {
  const refunds = [{ type: 'filter', column: 'refund', op: '!=', value: 'yes' }];
  const byName = new Map<string, Metric>([
    ['revenue', metric('Revenue', { column: 'revenue', aggregation: 'sum' }, refunds)],
    ['profit', metric('Profit', { column: 'profit', aggregation: 'sum' })],
    ['cost', metric('Cost', { column: 'cost', aggregation: 'sum' })],
    ['orders', metric('Orders', { column: 'day', aggregation: 'count' })],
    ['loop a', metric('Loop A', { formula: '[Loop B] + 1' })],
    ['loop b', metric('Loop B', { formula: '[Loop A]' })],
    ['elsewhere', metric('Elsewhere', { column: 'revenue', aggregation: 'sum' }, [], 'OTHER')],
  ]);
  const sh = (def: any, filters: any[] = []): Shape => shapeMod.metricShape('D', COLS, def, filters, byName);

  const s1 = sh({ column: 'revenue', aggregation: 'sum' });
  ok('shape: sum is additive over one sum operand',
    s1.kind === 'additive' && s1.operands.length === 1 && s1.operands[0].agg === 'sum' && JSON.stringify(s1.num.terms) === '[{"op":0,"coef":1}]');
  const s2 = sh({ column: 'region', aggregation: 'count' });
  ok('shape: count over a TEXT column is additive (non-empty cells)', s2.kind === 'additive' && s2.operands[0].agg === 'count');
  const s3 = sh({ column: 'revenue', aggregation: 'avg' });
  ok('shape: avg is a ratio of a sum over a numeric count',
    s3.kind === 'ratio' && s3.operands.map((o) => o.agg).join() === 'sum,ncount');
  ok('shape: min and max are refused, with a reason',
    sh({ column: 'revenue', aggregation: 'min' }).kind === 'none' && /cannot be split/.test((sh({ column: 'revenue', aggregation: 'max' }) as any).reason));
  ok('shape: a sum over a text column is refused (declared type, never inference)', sh({ column: 'region', aggregation: 'sum' }).kind === 'none');

  const margin = sh({ formula: '[Profit] / [Revenue]' });
  ok('shape: [Profit] / [Revenue] is a ratio', margin.kind === 'ratio' && margin.operands.length === 2);
  ok('shape: a referenced metric keeps ITS OWN filters (Revenue excludes refunds)',
    margin.kind === 'ratio' && JSON.stringify(margin.operands[1].filters) === JSON.stringify(refunds) && margin.operands[0].filters.length === 0);
  const m2 = sh({ formula: '([Revenue] - [Cost]) / [Revenue]' });
  ok('shape: (a − b) / a is a ratio with a linear numerator',
    m2.kind === 'ratio' && JSON.stringify(m2.num.terms) === '[{"op":0,"coef":1},{"op":1,"coef":-1}]' && JSON.stringify(m2.den.terms) === '[{"op":0,"coef":1}]');
  const aov = sh({ formula: '[Revenue] / [Orders] * 100' });
  ok('shape: a ratio times a constant is still a ratio (numerator scaled)',
    aov.kind === 'ratio' && aov.num.terms[0].coef === 100);
  const inline = sh({ formula: 'sum(profit) - sum(cost)' }, [{ type: 'filter', column: 'region', op: '=', value: 'West' }]);
  ok('shape: totals written in a formula take THAT metric\'s filters',
    inline.kind === 'additive' && inline.operands.every((o) => o.filters.length === 1 && o.filters[0].column === 'region'));
  ok('shape: a constant offset is refused', sh({ formula: '[Revenue] + 5' }).kind === 'none');
  ok('shape: a product of two measures is refused', sh({ formula: '[Revenue] * [Cost]' }).kind === 'none');
  ok('shape: a function call is refused', sh({ formula: 'abs([Revenue])' }).kind === 'none');
  ok('shape: a cycle is refused, never a hang', sh({ formula: '[Loop A]' }).kind === 'none');
  ok('shape: a metric on another dataset is refused', sh({ formula: '[Elsewhere] / [Revenue]' }).kind === 'none');
  ok('shape: an unknown metric is refused', sh({ formula: '[Nope] / [Revenue]' }).kind === 'none');
  const shared = sh({ formula: '[Revenue] / [Revenue]' });
  ok('shape: one operand shared by numerator and denominator is computed once', shared.kind === 'ratio' && shared.operands.length === 1);
  ok('evalLinear: a null operand makes the figure null', shapeMod.evalLinear({ terms: [{ op: 0, coef: 1 }] }, [null]) === null);
}

// ── 2. additive ──────────────────────────────────────────────────────────────

const SUM: Shape = { kind: 'additive', operands: [{ column: 'v', agg: 'sum', filters: [] }], num: { terms: [{ op: 0, coef: 1 }] } };

function dim(column: string, pairs: Array<[string, number, number]>): import('../src/analysis/drivers').DimensionAgg {
  return { column, members: pairs.map(([key, a, b]) => ({ key, a: [a], b: [b] })) };
}

function additiveChecks(): void {
  // Twelve members: six up, five down, one flat. Integers, so every sum is exact.
  const pairs: Array<[string, number, number]> = [
    ['a', 150, 100], ['b', 90, 100], ['c', 130, 100], ['d', 40, 100], ['e', 101, 100], ['f', 100, 100],
    ['g', 70, 100], ['h', 160, 100], ['i', 99, 100], ['j', 120, 100], ['k', 20, 100], ['l', 105, 100],
  ];
  const d = dim('x', pairs);
  const A = pairs.reduce((s, p) => s + p[1], 0);
  const B = pairs.reduce((s, p) => s + p[2], 0);
  const totals = drv.totalsOf(SUM, [A], [B]);
  ok('totals: A, B and the delta', totals.a === A && totals.b === B && totals.delta === A - B);
  const r = drv.explainDimension(SUM, d, totals, { a: [A], b: [B] });
  ok('explain: a result', !!r);
  if (!r || totals.delta === null) return;
  let sum = 0;
  for (const m of r.members) sum += m.delta;
  ok('additive: the member changes sum EXACTLY to the delta', Object.is(sum, totals.delta), `${sum} vs ${totals.delta}`);
  const w = r.waterfall;
  ok('waterfall: starts at B and ends at A', w.start === B && w.end === A);
  ok('waterfall: top five up, largest first', w.steps.slice(0, 5).map((s) => s.key).join() === 'h,a,c,j,l');
  ok('waterfall: then top five down, most negative first', w.steps.slice(5).map((s) => s.key).join() === 'k,d,g,b,i');
  const shown = new Set(w.steps.map((s) => s.key));
  const rest = pairs.filter((p) => !shown.has(p[0]));
  ok('"other": the members not shown, counted', w.other.count === rest.length && rest.map((p) => p[0]).sort().join() === 'e,f');
  ok('"other": its change is exactly the rest\'s', Object.is(w.other.delta, rest.reduce((s, p) => s + (p[1] - p[2]), 0)));
  let run = w.start;
  for (const s of w.steps) run += s.delta;
  ok('waterfall: start + steps + other closes on end', Object.is(run + w.other.delta, w.end));
  ok('members: every one, largest |delta| first', r.members.length === 12 && r.members[0].key === 'k');
  ok('share: a member\'s % of the change', close(r.members[0].share, ((20 - 100) / totals.delta) * 100));

  // Explained variance.
  const uniform = drv.explainedVariance([10, 20, 30], [100, 200, 300], [110, 220, 330], 60);
  ok('explained variance: every member moved at the overall rate → 0', Object.is(uniform, 0));
  const one = drv.explainedVariance([-60, 0, 0], [100, 200, 300], [40, 200, 300], -60);
  ok('explained variance: the change in one member → high', one > 0.5 && one < 1);
  ok('explained variance: members offsetting with no net change → 1', drv.explainedVariance([50, -50], [100, 100], [150, 50], 0) === 1);
  ok('explained variance: nothing moved → 0', drv.explainedVariance([0, 0], [1, 1], [1, 1], 0) === 0);

  // A null (no numbers) in one period is nothing, never NaN.
  const holes = drv.explainDimension(SUM, { column: 'x', members: [{ key: 'p', a: [5], b: [null] }, { key: 'q', a: [null], b: [3] }] },
    drv.totalsOf(SUM, [5], [3]), { a: [5], b: [3] });
  ok('additive: a member with no numbers in a period counts as nothing', !!holes && holes.members.every((m) => Number.isFinite(m.delta)));

  ok('lead member: for a fall (this total fell), the largest fall', totals.delta < 0 && drv.leadMember(r.members, totals.delta)?.key === 'k');
  ok('lead member: for a rise, the largest rise', drv.leadMember(r.members, 1)?.key === 'h');
}

// ── 3. ratio ─────────────────────────────────────────────────────────────────

const RATIO: Shape = {
  kind: 'ratio',
  operands: [{ column: 'n', agg: 'sum', filters: [] }, { column: 'd', agg: 'sum', filters: [] }],
  num: { terms: [{ op: 0, coef: 1 }] },
  den: { terms: [{ op: 1, coef: 1 }] },
};

function ratioChecks(): void {
  // Dyadic figures (powers of two) so every product and quotient is exact.
  const members = [
    { key: 'East', a: [24, 64], b: [8, 32] },
    { key: 'West', a: [4, 32], b: [16, 64] },
    { key: 'New', a: [8, 32], b: [0, 0] },   // only in A: all mix
    { key: 'Gone', a: [0, 0], b: [4, 32] },  // only in B: all mix
  ];
  const tA = [36, 128];
  const tB = [28, 128];
  const totals = drv.totalsOf(RATIO, tA, tB);
  ok('ratio totals: N / D in each period', totals.a === 36 / 128 && totals.b === 28 / 128 && totals.delta === 8 / 128);
  const r = drv.explainDimension(RATIO, { column: 'region', members }, totals, { a: tA, b: tB });
  ok('ratio: a result', !!r);
  if (!r) return;
  for (const m of r.members) {
    const src = members.find((x) => x.key === m.key)!;
    const contribution = src.a[0] / tA[1] - src.b[0] / tB[1];
    ok(`ratio: mix + rate = ${m.key}'s contribution`, m.mix !== undefined && m.rate !== undefined && Object.is(m.mix + m.rate, contribution),
      `${m.mix} + ${m.rate} vs ${contribution}`);
  }
  ok('ratio: a member in one period only is all mix, no rate',
    r.members.filter((m) => m.key === 'New' || m.key === 'Gone').every((m) => m.rate === 0));
  ok('ratio: a member in both has a rate effect', r.members.find((m) => m.key === 'East')!.rate !== 0);
  let sum = 0;
  for (const m of r.members) sum += m.delta;
  ok('ratio: the effects sum EXACTLY to the ratio change (dyadic figures)', Object.is(sum, totals.delta));

  // A non-dyadic case, within float rounding.
  const m2 = [{ key: 'x', a: [30, 100], b: [20, 90] }, { key: 'y', a: [10, 70], b: [25, 110] }];
  const t2 = drv.totalsOf(RATIO, [40, 170], [45, 200]);
  const r2 = drv.explainDimension(RATIO, { column: 'c', members: m2 }, t2, { a: [40, 170], b: [45, 200] });
  let s2 = 0;
  for (const m of r2!.members) s2 += (m.mix as number) + (m.rate as number);
  ok('ratio: mix + rate over all members = Rᴬ − Rᴮ', close(s2, (t2.delta as number), 1e-12));
  ok('ratio: a zero denominator in a period is no figure', drv.totalsOf(RATIO, [1, 0], [1, 2]).a === null);
}

// ── 4. ranking ───────────────────────────────────────────────────────────────

function rankingChecks(): void {
  const same: Array<[string, number, number]> = [['p', 10, 5], ['q', 5, 10]];
  const t = drv.totalsOf(SUM, [15], [15]);
  const mk = (col: string) => drv.explainDimension(SUM, dim(col, same), t, { a: [15], b: [15] })!;
  const order = ['zeta', 'alpha', 'mid'];
  const r1 = drv.rankDimensions([mk('alpha'), mk('zeta'), mk('mid')], order).map((d) => d.column).join();
  const r2 = drv.rankDimensions([mk('mid'), mk('alpha'), mk('zeta')], order).map((d) => d.column).join();
  ok('ranking: ties follow the dataset\'s column order', r1 === 'zeta,alpha,mid', r1);
  ok('ranking: stable whatever order the groups arrive in', r1 === r2);
  const strong = drv.explainDimension(SUM, dim('strong', [['p', 30, 10], ['q', 10, 10]]), drv.totalsOf(SUM, [40], [20]), { a: [40], b: [20] })!;
  const weak = drv.explainDimension(SUM, dim('weak', [['p', 20, 10], ['q', 20, 10]]), drv.totalsOf(SUM, [40], [20]), { a: [40], b: [20] })!;
  ok('ranking: the dimension whose members moved unevenly ranks first',
    drv.rankDimensions([weak, strong], ['weak', 'strong'])[0].column === 'strong');
  const tieA = drv.buildWaterfall([
    { key: 'b', label: 'b', a: 2, b: 1, delta: 1, share: null },
    { key: 'a', label: 'a', a: 2, b: 1, delta: 1, share: null },
  ], 2, 4);
  ok('waterfall: tied members in key order', tieA.steps.map((s) => s.key).join() === 'a,b');
}

// ── 5. scopes and words ──────────────────────────────────────────────────────

function scopeChecks(): void {
  ok('bucket: a month', JSON.stringify(scope.bucketRange('2024-02', 'month')) === '{"from":"2024-02-01","to":"2024-02-29"}');
  ok('bucket: a quarter', JSON.stringify(scope.bucketRange('2023-Q4', 'quarter')) === '{"from":"2023-10-01","to":"2023-12-31"}');
  ok('bucket: a year', JSON.stringify(scope.bucketRange('2024', 'year')) === '{"from":"2024-01-01","to":"2024-12-31"}');
  ok('bucket: a week is seven days from its first', JSON.stringify(scope.bucketRange('2024-03-11', 'week')) === '{"from":"2024-03-11","to":"2024-03-17"}');
  ok('bucket: a day', JSON.stringify(scope.bucketRange('2024-03-11', 'day')) === '{"from":"2024-03-11","to":"2024-03-11"}');
  ok('bucket: a label in the wrong shape is refused', scope.bucketRange('2024-13', 'month') === null && scope.bucketRange('Mar', 'month') === null);
  ok('label: a whole month', scope.rangeLabel({ from: '2024-02-01', to: '2024-02-29' }) === 'Feb 2024');
  ok('label: a whole quarter', scope.rangeLabel({ from: '2024-04-01', to: '2024-06-30' }) === 'Q2 2024');
  ok('label: a whole year', scope.rangeLabel({ from: '2023-01-01', to: '2023-12-31' }) === '2023');
  ok('label: a span of days', scope.rangeLabel({ from: '2024-03-03', to: '2024-04-02' }) === 'Mar 3 – Apr 2, 2024');

  const feb = { type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-02-01', to: '2024-02-29' } } as any;
  const base = scope.sanitizeDriversSpec({
    datasetId: '00000000-0000-4000-8000-000000000001',
    metric: { column: 'revenue', aggregation: 'sum' },
    compare: { mode: 'previous_period' },
    path: [{ column: 'region', value: 'West' }, { column: 'region', value: 'dup' }, { column: 'state', value: '' }],
  }, [feb]);
  ok('spec: sanitized, a repeated path column dropped', !!base && base.path.length === 2);
  const sc = base ? scope.periodScopes(base, COLS) : null;
  ok('scopes: KPI Compare moves the date range to the previous period',
    !!sc && !('reason' in sc) && JSON.stringify(sc.b.find((s: any) => s.op === 'period')) ===
      JSON.stringify({ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-01-01', to: '2024-01-31' } }));
  ok('scopes: labels read as periods', !!sc && !('reason' in sc) && sc.aLabel === 'Feb 2024' && sc.bLabel === 'Jan 2024' && sc.column === 'day');
  ok('scopes: the path is applied to both periods, blank as is_empty',
    !!sc && !('reason' in sc) && sc.a.some((s: any) => s.column === 'region' && s.op === '=' && s.value === 'West') &&
    sc.b.some((s: any) => s.column === 'state' && s.op === 'is_empty'));
  const none = scope.periodScopes({ ...base!, filters: [] }, COLS);
  ok('scopes: no date range in scope is a sentence, not a guess', 'reason' in none && /date/.test(none.reason));
  const bucket = scope.sanitizeDriversSpec({
    datasetId: '00000000-0000-4000-8000-000000000001', metric: { column: 'revenue', aggregation: 'sum' },
    compare: { mode: 'bucket', column: 'day', label: '2024-02', prev: '2024-01', grain: 'month' },
  }, []);
  const bs = bucket ? scope.periodScopes(bucket, COLS) : null;
  ok('scopes: a chart point compares its bucket with the one before',
    !!bs && !('reason' in bs) && bs.aLabel === 'Feb 2024' && bs.bLabel === 'Jan 2024' && bs.a.length === 1 && bs.b.length === 1);
  ok('spec: a bucket label in the wrong shape is refused',
    scope.sanitizeDriversSpec({ datasetId: '00000000-0000-4000-8000-000000000001', metric: { column: 'x', aggregation: 'sum' },
      compare: { mode: 'bucket', column: 'day', label: 'Feb', prev: 'Jan', grain: 'month' } }, []) === null);
  ok('spec: a metric needs an id or a column rollup',
    scope.sanitizeDriversSpec({ datasetId: '00000000-0000-4000-8000-000000000001', metric: {}, compare: { mode: 'previous_year' } }, []) === null);
  ok('alert scope: the period column\'s bounds are dropped, other filters kept',
    JSON.stringify(scope.withoutDateBounds([feb, { type: 'filter', column: 'region', op: '=', value: 'West' } as any], 'day')) ===
      JSON.stringify([{ type: 'filter', column: 'region', op: '=', value: 'West' }]));

  ok('caption: the shape the panel promises',
    drv.driversCaption({ metric: 'Revenue', delta: -412, deltaText: '$412K', top: { label: 'West', share: 61.2 }, lead: { label: 'California', deltaText: '−$190K' } }) ===
      'Revenue fell $412K; West explains 61%, led by California at −$190K.');
  ok('caption: offsetting members are named as such',
    /explains 121% — other members offset part of it/.test(drv.driversCaption({ metric: 'Revenue', delta: -1, deltaText: '1', top: { label: 'West', share: 121 }, lead: null })));
  ok('caption: no change', drv.driversCaption({ metric: 'Units', delta: 0, deltaText: '0', top: null, lead: null }) === 'Units did not change overall.');
  ok('caption: members that cancel out are named as offsetting, not as 1,457%',
    drv.driversCaption({ metric: 'Profit', delta: 215.8, deltaText: '$215.8', top: { label: 'California', share: 1457, deltaText: '+$3.1K' }, lead: null, offsetting: true }) ===
      'Profit rose $215.8 as members offset each other; California moved the most, +$3.1K.');
  ok('offsetting: a small net over big moves', drv.isOffsetting([{ delta: 100 }, { delta: -95 }], 5) && !drv.isOffsetting([{ delta: 100 }, { delta: -10 }], 90));

  // A TEXT period key (a calculated "YYYY-MM" field) is matched exactly, not cut by dates.
  const TXT = COLS.concat([{ name: 'month_key', type: 'text' }]);
  const txt = scope.sanitizeDriversSpec({
    datasetId: '00000000-0000-4000-8000-000000000001', metric: { column: 'revenue', aggregation: 'sum' },
    compare: { mode: 'bucket', column: 'month_key', label: '2024-02', prev: '2024-01', grain: 'month' },
  }, []);
  const ts = txt ? scope.periodScopes(txt, TXT) : null;
  ok('scopes: a text period key is an exact match on its label',
    !!ts && !('reason' in ts) && JSON.stringify(ts.a) === JSON.stringify([{ type: 'filter', column: 'month_key', op: '=', value: '2024-02' }]));
  ok('scopes: a number column is not a period', 'reason' in scope.periodScopes({ ...txt!, compare: { ...txt!.compare, column: 'revenue' } as any }, TXT));
}

// ── 6. end to end ────────────────────────────────────────────────────────────

// Two months; February loses most of its revenue in California. Integers only,
// so the resident and JS paths agree to the bit. ×REP rows so the table is big
// enough for the resident path (≥ 1,000 rows).
const REP = 90;
const JAN: Array<[string, string, string, number, number]> = [
  ['East', 'New York', 'A', 100, 20], ['East', 'New York', 'B', 100, 20], ['East', 'Boston', 'A', 100, 20], ['East', 'Boston', 'B', 100, 20],
  ['West', 'California', 'A', 200, 50], ['West', 'California', 'B', 200, 50], ['West', 'Nevada', 'A', 100, 20], ['West', 'Nevada', 'B', 100, 20],
  ['South', 'Texas', 'A', 100, 10], ['South', 'Texas', 'B', 100, 10], ['South', 'Florida', 'A', 100, 10], ['South', 'Florida', 'B', 100, 10],
];
const FEB: Array<[string, string, string, number, number]> = [
  ['East', 'New York', 'A', 90, 20], ['East', 'New York', 'B', 100, 20], ['East', 'Boston', 'A', 95, 20], ['East', 'Boston', 'B', 95, 20],
  ['West', 'California', 'A', 50, 10], ['West', 'California', 'B', 50, 10], ['West', 'Nevada', 'A', 90, 20], ['West', 'Nevada', 'B', 90, 20],
  ['South', 'Texas', 'A', 90, 10], ['South', 'Texas', 'B', 90, 10], ['South', 'Florida', 'A', 100, 10], ['South', 'Florida', 'B', 100, 10],
];

async function endToEnd(): Promise<void> {
  const project = await projects.createProject('Drivers test');
  const pid = project.id;
  const rows: (string | number | null)[][] = [];
  for (let k = 0; k < REP; k += 1) {
    for (const r of JAN) rows.push(['2024-01-15', r[0], r[1], r[2], r[3], r[4], 5, 'no', 'Jan']);
    for (const r of FEB) rows.push(['2024-02-15', r[0], r[1], r[2], r[3], r[4], 5, 'no', 'Feb']);
  }
  const ds = await datasets.saveDataset(pid, { name: 'Sales', sourceKind: 'csv', columns: COLS as any, rows });
  ok('fixture dataset saved', !!ds);
  if (!ds) return;
  const save = (name: string, definition: any, format: any = { kind: 'number', decimals: 0, compact: false }) =>
    metrics.saveMetric(pid, { name, datasetId: ds.id, definition, format, direction: 'up_good' } as any);
  const revenue = await save('Revenue', { column: 'revenue', aggregation: 'sum' });
  await save('Profit', { column: 'profit', aggregation: 'sum' });
  const margin = await save('Margin %', { formula: '[Profit] / [Revenue]' }, { kind: 'percent', decimals: 1, compact: false });
  ok('fixture metrics saved', !!revenue && !!margin);
  if (!revenue || !margin) return;

  const feb = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-02-01', to: '2024-02-29' } }] as any[];
  const jan = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-01-01', to: '2024-01-31' } }] as any[];
  const spec = scope.sanitizeDriversSpec({ datasetId: ds.id, metric: { metricId: revenue.id }, compare: { mode: 'previous_period' } }, feb)!;

  const meta = await datasets.getDatasetMeta(pid, ds.id);
  const resident = !!meta && meta.resident && residentQuery.isResident();
  let hydrations = 0;
  const realGet = datasets.getDataset;
  (datasets as any).getDataset = async (...args: any[]) => { hydrations += 1; return (realGet as any)(...args); };
  const fast = await ipc.driversFor(pid, spec);
  const hydratedResident = hydrations;
  (datasets as any).getDataset = realGet;
  ok('explain: an answer', fast.ok === true, JSON.stringify(fast).slice(0, 300));
  if (!fast.ok) return;
  if (resident) ok('resident: the table was never hydrated', hydratedResident === 0, `${hydratedResident} hydrations`);
  else console.log('skip resident no-hydration check: the DuckDB bridge is not available here');

  const now = await metricsIpc.resolveMetric(pid, revenue.id, { filters: feb });
  const before = await metricsIpc.resolveMetric(pid, revenue.id, { filters: jan });
  ok('totals: equal the metrics layer\'s own figures', Object.is(fast.totals.a, now?.value) && Object.is(fast.totals.b, before?.value),
    `${fast.totals.a}/${now?.value} ${fast.totals.b}/${before?.value}`);
  ok('totals: the delta', fast.totals.delta === (1100 - 1400 - 60) * REP);
  ok('dimensions: every text column with 2–200 members, ranked', fast.dimensions.map((d) => d.column).join() === 'state,region,category',
    fast.dimensions.map((d) => `${d.column}:${d.explained}`).join(' '));
  ok('dimensions: the refund column (one member) is not one', !fast.dimensions.some((d) => d.column === 'refund'));
  ok('dimensions: a column that only re-labels the periods (Jan/Feb) explains nothing', !fast.dimensions.some((d) => d.column === 'mon'));
  ok('offsetting: not here — the fall is mostly one state', fast.selected?.offsetting === false);
  ok('move share: members\' shares of all movement sum to 100',
    !!fast.selected && close(fast.selected.members.reduce((s, m) => s + m.moveShare, 0), 100, 1e-9));
  ok('selected: the best dimension by default', fast.selected?.column === 'state');
  const ca = fast.selected?.waterfall.steps.find((s) => s.key === 'California');
  ok('waterfall: California is the largest fall', fast.selected?.waterfall.steps[0]?.key === 'California' || (!!ca && ca.delta === -300 * REP));
  ok('caption: names the change, the leader and the next level down',
    /^Revenue fell .+; California explains 83%, led by A at −/.test(fast.caption), fast.caption);
  ok('headline: the change in words', /^Revenue fell /.test(fast.headline));
  ok('alert: prefilled for a column rollup, without the date bounds',
    !!fast.alert && fast.alert.column === 'revenue' && fast.alert.periodColumn === 'day' && fast.alert.filters.length === 0 && fast.alert.direction === 'down');

  // Resident ≡ JS, end to end: the same question with the bridge turned off.
  const realIs = residentQuery.isResident;
  (residentQuery as any).isResident = () => false;
  const slow = await ipc.driversFor(pid, spec);
  (residentQuery as any).isResident = realIs;
  ok('resident ≡ JS: every figure, Object.is',
    slow.ok && JSON.stringify({ ...slow, token: '' }) === JSON.stringify({ ...fast, token: '' }));

  // Drill: West → its states.
  const west = await ipc.driversFor(pid, { ...spec, path: [{ column: 'region', value: 'West' }] });
  ok('drill: inside West, region is spent and the change is West\'s alone',
    west.ok && !west.dimensions.some((d) => d.column === 'region') && west.totals.delta === -320 * REP);

  // A ratio.
  const mspec = scope.sanitizeDriversSpec({ datasetId: ds.id, metric: { metricId: margin.id }, compare: { mode: 'previous_period' } }, feb)!;
  const mr = await ipc.driversFor(pid, mspec, undefined);
  const mNow = await metricsIpc.resolveMetric(pid, margin.id, { filters: feb });
  ok('ratio: Margin % splits, and its totals are the metric\'s own', mr.ok && mr.metric.kind === 'ratio' && close(mr.totals.a, mNow?.value as number));
  if (mr.ok && mr.selected) {
    let s = 0;
    for (const m of mr.selected.members) s += (m.mix as number) + (m.rate as number);
    ok('ratio: mix + rate over the members = the ratio change', close(s, mr.totals.delta as number, 1e-12));
    ok('ratio: a change in a percent reads in points', / pts$/.test(mr.totals.deltaText), mr.totals.deltaText);
  }

  // The Assistant's facts: recalled by token, every printed figure in the ledger.
  const facts = await copilot.buildFacts(pid, { kind: 'drivers', id: fast.token });
  ok('facts: the question and the leader are in the text', /why did "Revenue" change/.test(facts.text) && /California/.test(facts.text));
  ok('facts: every figure printed is in the ledger', audit.auditNumbers(facts.text, facts.ledger).ok);
  ok('facts: a token from another project recalls nothing', ipc.recall('00000000-0000-4000-8000-00000000abcd', fast.token) === null);

  // The waterfall tile: recomputed from the question, under the sheet's filters.
  const tile = await ipc.driversVizData(pid, ds.id, { category: 'state', drivers: { metric: { metricId: revenue.id }, compare: { mode: 'previous_period' }, path: [] } }, feb);
  ok('tile: an answer', tile.ok === true);
  if (tile.ok) {
    const v = tile.data.series[0].values as number[];
    ok('tile: starts at B and ends at A under fixed total labels',
      tile.data.labels[0] === ipc.TILE_START && tile.data.labels[tile.data.labels.length - 1] === ipc.TILE_END &&
      v[0] === 1400 * REP && v[v.length - 1] === (1400 - 360) * REP);
    let mid = 0;
    for (const x of v.slice(1, -1)) mid += x;
    ok('tile: the steps between sum to the change', mid === -360 * REP);
  }

  // An alert's question: the two latest periods of the date column.
  const latest = await ipc.driversFor(pid, { ...spec, filters: [], compare: { mode: 'latest', column: 'day' } });
  ok('latest: the two most recent periods, named', latest.ok && latest.periods.a === 'Feb 15, 2024' && latest.periods.b === 'Jan 15, 2024' && latest.totals.delta === -360 * REP);

  const minSpec = scope.sanitizeDriversSpec({ datasetId: ds.id, metric: { column: 'revenue', aggregation: 'max' }, compare: { mode: 'previous_period' } }, feb)!;
  const mx = await ipc.driversFor(pid, minSpec);
  ok('max: not decomposable — a sentence, and the header still has both figures',
    mx.ok && !!mx.unavailable && mx.selected === null && mx.totals.a === 100 && mx.totals.b === 200);
}

async function main(): Promise<void> {
  shapeChecks();
  additiveChecks();
  ratioChecks();
  rankingChecks();
  scopeChecks();
  await endToEnd();
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
