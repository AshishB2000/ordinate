'use strict';

// Self-check for table calculations: src/analysis/tableCalc.ts (the kernel and
// the chart grid), src/analysis/pivotCalc.ts (the pivot grid, and its subtotal
// rule), the sanitizers that store a calc, the caption and facts that print
// one, and the renderer's display mirror (renderer/hub/calcMenu.ts).
//
// Every expected figure is hand-checkable — the arithmetic is in the comment
// beside it — and compared with `Object.is` against the SAME expression, so a
// float that differs in the last bit fails rather than rounds away.
//
//   npm run build:ts && node scripts/test-tableCalc.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { withT } from './i18nNode';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');
const Module: any = require('module');

// visuals.ts / dashboards.ts read `app` from electron at module load; nothing
// here touches disk through it.
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-tablecalc-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: () => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const tc: typeof import('../src/analysis/tableCalc') = require('../src/analysis/tableCalc');
const pivotData: typeof import('../src/analysis/pivotData') = require('../src/analysis/pivotData');
const pivotResident: typeof import('../src/engine/pivotResident') = require('../src/engine/pivotResident');
const pq: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const captions: typeof import('../src/analysis/captions') = require('../src/analysis/captions');
const facts: typeof import('../src/ai/copilotFacts') = require('../src/ai/copilotFacts');
const audit: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');
const format: typeof import('../src/app/format') = require('../src/app/format');

type TableCalc = import('../src/analysis/tableCalc').TableCalc;
type PivotEncoding = import('../src/analysis/pivotData').PivotEncoding;
type PivotGrid = import('../src/analysis/pivotData').PivotGrid;
type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;

const same = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const eq = (label: string, got: unknown[], want: unknown[]): void => ok(label, same(got, want), JSON.stringify({ got, want }));
const seq = (kind: TableCalc['kind'], values: (number | null)[], opts?: Parameters<typeof tc.calcSequence>[2]) =>
  tc.calcSequence(kind, values, opts);

// ── 1. The sanitizer's whitelist ─────────────────────────────────────────────

function testSanitize(): void {
  ok('sanitize: an unknown kind drops the whole calc', tc.sanitizeTableCalc({ kind: 'median', along: 'down' }) === undefined);
  ok('sanitize: a non-object is no calc', tc.sanitizeTableCalc('running_total') === undefined && tc.sanitizeTableCalc(null) === undefined);
  const a = tc.sanitizeTableCalc({ kind: 'running_total', along: 'sideways', extra: 1 });
  ok('sanitize: an unknown along becomes across, unknown keys go', JSON.stringify(a) === '{"kind":"running_total","along":"across"}', JSON.stringify(a));
  const d = tc.sanitizeTableCalc({ kind: 'pct_of_total', along: { dimension: 'region', x: 1 }, restart: 'category' });
  ok('sanitize: along a dimension, and restart, survive as strings',
     JSON.stringify(d) === '{"kind":"pct_of_total","along":{"dimension":"region"},"restart":"category"}', JSON.stringify(d));
  ok('sanitize: a window below 2 clamps to 2', tc.sanitizeTableCalc({ kind: 'moving_avg', along: 'down', window: 1 })?.window === 2);
  ok('sanitize: a window above 366 clamps to 366', tc.sanitizeTableCalc({ kind: 'moving_sum', along: 'down', window: 5000 })?.window === 366);
  ok('sanitize: a fractional window rounds (7.4 → 7)', tc.sanitizeTableCalc({ kind: 'moving_avg', along: 'down', window: 7.4 })?.window === 7);
  ok('sanitize: a non-number window is dropped (the default applies)',
     tc.sanitizeTableCalc({ kind: 'moving_avg', along: 'down', window: '5' })?.window === undefined);
  ok('sanitize: a window only on a moving kind', tc.sanitizeTableCalc({ kind: 'diff', along: 'down', window: 5 })?.window === undefined);
  ok('sanitize: an empty dimension name falls back to across',
     tc.sanitizeTableCalc({ kind: 'diff', along: { dimension: '' } })?.along === 'across');
}

// ── 2. The kernel, one kind at a time ────────────────────────────────────────

function testKernel(): void {
  // 10, 10+20, (null stays null), 30+30
  eq('running_total: a null is null and the total carries on', seq('running_total', [10, 20, null, 30]), [10, 30, null, 60]);
  // total = 10+30+60 = 100
  eq('pct_of_total: each ÷ the partition total, as a fraction', seq('pct_of_total', [10, 30, null, 60]), [10 / 100, 30 / 100, null, 60 / 100]);
  eq('pct_of_total: an explicit (source) total wins over the sum', seq('pct_of_total', [10, 30], { total: 200 }), [10 / 200, 30 / 200]);
  eq('pct_of_total: a zero total is null, never Infinity', seq('pct_of_total', [0, 0]), [null, null]);
  eq('pct_of_total: a missing source total is null', seq('pct_of_total', [5], { total: null }), [null]);
  // 15−10, null neighbour, 30−null, 25−30
  eq('diff: first and null-neighboured cells are null', seq('diff', [10, 15, null, 30, 25]), [null, 5, null, null, -5]);
  // (15−10)/10, (0−15)/15, base 0 → null
  eq('pct_diff: relative to |previous|; a zero base is null', seq('pct_diff', [10, 15, 0, 5]), [null, 5 / 10, -15 / 15, null]);
  eq('pct_diff: a negative base divides by its magnitude', seq('pct_diff', [-10, -5]), [null, 5 / 10]);
  eq('rank_dense: ties share, no gap (1, 2, 2, 3); null unranked', seq('rank_dense', [30, 20, 20, 10, null]), [1, 2, 2, 3, null]);
  eq('rank_competition: ties share, then a gap (1, 2, 2, 4)', seq('rank_competition', [30, 20, 20, 10, null]), [1, 2, 2, 4, null]);
  // competition ranks 1,2,2,4 over n = 4: (4−1)/3, (4−2)/3, (4−2)/3, (4−4)/3
  eq('percentile: (n − r) ÷ (n − 1), the top is 1', seq('percentile', [30, 20, 20, 10]), [3 / 3, 2 / 3, 2 / 3, 0]);
  eq('percentile: a single value is the top', seq('percentile', [5, null]), [1, null]);
  // windows [10], [10,20], [10,20,30], [20,30,40]
  eq('moving_avg N=3: fewer than N at the start averages what is there', seq('moving_avg', [10, 20, 30, 40], { window: 3 }),
     [10, 30 / 2, 60 / 3, 90 / 3]);
  eq('moving_sum N=3', seq('moving_sum', [10, 20, 30, 40], { window: 3 }), [10, 30, 60, 90]);
  // N=2: [10], null, [null,30]→30, [30,40]→35
  eq('moving_avg: nulls inside the window are skipped', seq('moving_avg', [10, null, 30, 40], { window: 2 }), [10, null, 30, 70 / 2]);
  eq('moving: the default window is 3', seq('moving_sum', [1, 2, 3, 4]), [1, 3, 6, 9]);
  // (110−100)/100, prior null, prior 0
  eq('yoy: against the prior bucket; missing or zero prior is null', seq('yoy', [110, 90, 50], { prior: [100, null, 0] }),
     [10 / 100, null, null]);
  // first non-null is 50: 50/50·100, 75/50·100, 25/50·100
  eq('index: ÷ the first non-null × 100', seq('index', [null, 50, 75, 25]), [null, 100, (75 / 50) * 100, (25 / 50) * 100]);
  eq('index: a zero first value is null throughout', seq('index', [0, 5]), [null, null]);
}

// ── 3. Charts: {labels, series} ──────────────────────────────────────────────

function testCharts(): void {
  const data = { labels: ['A', 'B', 'C'], series: [{ name: 'sum of x', values: [1, 3, 6] as (number | null)[] }] };
  const plain = { category: 'cat', values: [{ column: 'x', aggregation: 'sum' }] };
  ok('absent calc: the very same object comes back (Object.is)', Object.is(tc.applyChartCalcs(data, plain), data));
  const reply = { ok: true, data, recommendedShape: 'categorical', warnings: [] as string[] };
  ok('absent calc: withTableCalcs returns the reply itself', Object.is(tc.withTableCalcs(reply, plain), reply));

  const pct = tc.applyChartCalcs(data, { category: 'cat', values: [{ column: 'x', aggregation: 'sum', calc: { kind: 'pct_of_total', along: 'across' } }] });
  const s = pct.series[0] as import('../src/analysis/tableCalc').CalcSeries;
  // total 1+3+6 = 10
  eq('chart pct_of_total across: ÷ the series total', s.values, [1 / 10, 3 / 10, 6 / 10]);
  eq('chart: the raw figures ride along', s.raw || [], [1, 3, 6]);
  ok('chart: the calc rides along too', !!s.calc && s.calc.kind === 'pct_of_total');
  ok('chart: the input is not mutated', same(data.series[0].values, [1, 3, 6]));

  // Split: 2023 East 10 / West 30; 2024 East 30 / West 10 — down = within each year.
  const split = { labels: ['2023', '2024'], series: [{ name: 'East', values: [10, 30] }, { name: 'West', values: [30, 10] }] };
  const encDown = (along: TableCalc['along'], restart?: string) => ({
    category: 'year', series: 'region', values: [{ column: 'amount', aggregation: 'sum', calc: { kind: 'pct_of_total' as const, along, ...(restart ? { restart } : {}) } }],
  });
  const down = tc.applyChartCalcs(split, encDown('down'));
  eq('chart pct_of_total down: East ÷ each year\'s total (10/40, 30/40)', down.series[0].values, [10 / 40, 30 / 40]);
  eq('chart pct_of_total down: West likewise (30/40, 10/40)', down.series[1].values, [30 / 40, 10 / 40]);
  eq('chart: along the split dimension IS down', tc.applyChartCalcs(split, encDown({ dimension: 'region' })).series[0].values, [10 / 40, 30 / 40]);
  eq('chart: along the category dimension IS across (10/40, 30/40 of East)',
     tc.applyChartCalcs(split, encDown({ dimension: 'year' })).series[0].values, [10 / 40, 30 / 40]);
  const w: string[] = [];
  const unknown = tc.applyChartCalcs(split, encDown({ dimension: 'nope' }), null, w);
  ok('chart: an unknown dimension is ignored (across) with a warning',
     same(unknown.series[1].values, [30 / 40, 10 / 40]) && w.some((x) => /"nope"/.test(x)), JSON.stringify(w));
  const w2: string[] = [];
  tc.applyChartCalcs(split, encDown('across', 'ghost'), null, w2);
  ok('chart: an unknown restart is ignored with a warning', w2.some((x) => /restart "ghost"/.test(x)), JSON.stringify(w2));
  // Restart on the along axis: every cell is its own partition → a running total is the figure itself.
  const alone = tc.applyChartCalcs(split, { category: 'year', series: 'region', values: [{ column: 'a', calc: { kind: 'running_total', along: 'across', restart: 'year' } }] });
  eq('chart: restarting on the along axis leaves one cell per partition', alone.series[0].values, [10, 30]);
  const run = tc.applyChartCalcs(split, { category: 'year', series: 'region', values: [{ column: 'a', calc: { kind: 'running_total', along: 'across' } }] });
  eq('chart running_total across: 10, 10+30', run.series[0].values, [10, 40]);

  // Year over year on a monthly date axis; 2024-03 has no 2023-03.
  const months = { labels: ['2023-01', '2023-02', '2024-01', '2024-02', '2024-03'], series: [{ name: 'sum of r', values: [100, 200, 110, 150, 90] }] };
  const yoyEnc = { category: 'd', values: [{ column: 'r', aggregation: 'sum', calc: { kind: 'yoy' as const, along: 'across' as const } }] };
  const yoy = tc.applyChartCalcs(months, yoyEnc, { kind: 'date', grain: 'month' });
  // (110−100)/100, (150−200)/200, no prior bucket
  eq('chart yoy: each month against the same month a year earlier; a missing prior is null',
     yoy.series[0].values, [null, null, 10 / 100, -50 / 200, null]);
  const w3: string[] = [];
  const notDate = tc.applyChartCalcs(months, yoyEnc, { kind: 'text' }, w3);
  ok('chart yoy: a non-date category yields nulls and says why',
     notDate.series[0].values.every((v) => v === null) && w3.some((x) => /date category/.test(x)), JSON.stringify(w3));

  const w4: string[] = [];
  const rawEnc = { category: 'c', values: [{ column: 'x', aggregation: 'none', calc: { kind: 'running_total' as const, along: 'across' as const } }] };
  ok('chart: never on raw rows — an all-none chart is untouched, with a warning',
     Object.is(tc.applyChartCalcs(data, rawEnc, null, w4), data) && w4.length === 1);
  ok('chart: a map is untouched', Object.is(tc.applyChartCalcs(data, { ...plain, values: [{ column: 'x', calc: { kind: 'diff', along: 'across' } }], geo: { level: 'country' } }), data));
}

// ── 4. Pivots, and the subtotal rule ─────────────────────────────────────────

const COLS: ParsedColumn[] = [
  { name: 'category', type: 'text' }, { name: 'sub', type: 'text' }, { name: 'region', type: 'text' },
  { name: 'amount', type: 'number' }, { name: 'day', type: 'date' },
];
//            West   East  | Total
//   Furn       40     60  |  100    (Chairs 10/20, Tables 30/40)
//   Tech      100    200  |  300    (Phones 100/200)
//   Total     140    260  |  400
const ROWS: Cell[][] = [
  ['Furn', 'Chairs', 'West', 10, '2023-01-15'],
  ['Furn', 'Chairs', 'East', 20, '2023-02-20'],
  ['Furn', 'Tables', 'West', 30, '2023-04-10'],
  ['Furn', 'Tables', 'East', 40, '2024-01-05'],
  ['Tech', 'Phones', 'West', 100, '2024-02-11'],
  ['Tech', 'Phones', 'East', 200, '2024-07-30'],
];

function penc(calc: TableCalc | undefined, over: Partial<PivotEncoding> = {}, aggregation: 'sum' | 'avg' | 'count' = 'sum'): PivotEncoding {
  return {
    rows: [{ column: 'category' }, { column: 'sub' }],
    columns: [{ column: 'region' }],
    values: [{ column: 'amount', aggregation, ...(calc ? { calc } : {}) }],
    totals: { rows: false, columns: false, grand: false },
    ...over,
  };
}
const grid = (e: PivotEncoding): PivotGrid => pivotData.buildPivotGrid(COLS, ROWS, e).grid;
const at = (g: PivotGrid, p: string, c: number): number | null => g.cells[g.rowHeaders.findIndex((h) => h.join('/') === p)][c];

function testPivot(): void {
  const plain = grid(penc(undefined));
  ok('pivot: no calc → no calc keys on the grid at all', !('calcs' in plain) && !('rawCells' in plain) && !('calcWarnings' in plain));

  // Percent of total, down, no restart: every cell ÷ its SOURCE column total (West 140, East 260).
  const g = grid(penc({ kind: 'pct_of_total', along: 'down' }));
  ok('pivot pct_of_total: a leaf is its figure ÷ the column total (10/140)', Object.is(at(g, 'Furn/Chairs', 0), 10 / 140));
  ok('pivot pct_of_total: a subtotal is its OWN source subtotal ÷ the total (40/140)', Object.is(at(g, 'Furn', 0), 40 / 140));
  ok('pivot pct_of_total: East Tech is 200/260', Object.is(at(g, 'Tech', 1), 200 / 260));
  ok('pivot: rawCells keep the figures', Object.is(g.rawCells?.[0][0], 40));
  ok('pivot: calcs name the calc per value', g.calcs?.[0]?.kind === 'pct_of_total');

  // AVG: summing shares would be wrong. West rows: Chairs 10, Tables 30, Phones 100.
  // Furn West avg = (10+30)/2 = 20; the West column avg = (10+30+100)/3 = 140/3.
  const ga = grid(penc({ kind: 'pct_of_total', along: 'down' }, {}, 'avg'));
  const furn = at(ga, 'Furn', 0) as number;
  const kids = (at(ga, 'Furn/Chairs', 0) as number) + (at(ga, 'Furn/Tables', 0) as number);
  ok('pivot avg: the subtotal share is 20 ÷ (140/3), from source', Object.is(furn, 20 / (140 / 3)), String(furn));
  ok('pivot avg: …which is NOT the sum of its children\'s shares ((10+30) ÷ (140/3))', Math.abs(furn - kids) > 0.1, `${furn} vs ${kids}`);
  // COUNT: West has 3 rows, Furn West 2 → 2/3, from the source count.
  const gc = grid(penc({ kind: 'pct_of_total', along: 'down' }, {}, 'count'));
  ok('pivot count: the subtotal share is 2 ÷ 3 source rows', Object.is(at(gc, 'Furn', 0), 2 / 3));
  ok('pivot count: a leaf share is 1 ÷ 3', Object.is(at(gc, 'Furn/Tables', 0), 1 / 3));

  // Restart every category: a leaf ÷ its category subtotal; the category rows run among themselves.
  const gr = grid(penc({ kind: 'pct_of_total', along: 'down', restart: 'category' }));
  ok('pivot restart: Chairs West ÷ Furn West (10/40)', Object.is(at(gr, 'Furn/Chairs', 0), 10 / 40));
  ok('pivot restart: Phones West ÷ Tech West (100/100)', Object.is(at(gr, 'Tech/Phones', 0), 100 / 100));
  ok('pivot restart: a category row is partitioned by its parent (40/140)', Object.is(at(gr, 'Furn', 0), 40 / 140));
  // Along the inner dimension means the same thing as restarting at the outer one.
  const gd = grid(penc({ kind: 'pct_of_total', along: { dimension: 'sub' } }));
  ok('pivot: along "sub" restarts every category', Object.is(at(gd, 'Furn/Tables', 1), 40 / 60));

  // Running total down among peers: West leaves 10, 30, 100; restart category → 10, 40 | 100.
  const rt = grid(penc({ kind: 'running_total', along: 'down', restart: 'category' }));
  eq('pivot running_total restart: 10, 10+30 | 100 (a restart boundary)',
     [at(rt, 'Furn/Chairs', 0), at(rt, 'Furn/Tables', 0), at(rt, 'Tech/Phones', 0)], [10, 40, 100]);
  eq('pivot running_total: the subtotal rows run among themselves (40, 40+100)', [at(rt, 'Furn', 0), at(rt, 'Tech', 0)], [40, 140]);
  const rt2 = grid(penc({ kind: 'running_total', along: 'down' }));
  eq('pivot running_total, no restart: 10, 40, 140 across the leaves', [at(rt2, 'Furn/Chairs', 0), at(rt2, 'Furn/Tables', 0), at(rt2, 'Tech/Phones', 0)], [10, 40, 140]);

  // Across: each row ÷ its source row total (Chairs 10+20 = 30).
  const ac = grid(penc({ kind: 'pct_of_total', along: 'across' }));
  eq('pivot pct_of_total across: Chairs 10/30, 20/30', [at(ac, 'Furn/Chairs', 0), at(ac, 'Furn/Chairs', 1)], [10 / 30, 20 / 30]);
  const diffAcross = grid(penc({ kind: 'diff', along: 'across' }));
  eq('pivot diff across: East − West per row (null, 20−10)', [at(diffAcross, 'Furn/Chairs', 0), at(diffAcross, 'Furn/Chairs', 1)], [null, 10]);

  // Rank down with ties and a restart: West leaves 10, 30, 100.
  const rk = grid(penc({ kind: 'rank_competition', along: 'down' }));
  eq('pivot rank down: Phones 1, Tables 2, Chairs 3', [at(rk, 'Tech/Phones', 0), at(rk, 'Furn/Tables', 0), at(rk, 'Furn/Chairs', 0)], [1, 2, 3]);
  const rkr = grid(penc({ kind: 'rank_dense', along: 'down', restart: 'category' }));
  eq('pivot rank restart: Tables 1, Chairs 2 | Phones 1', [at(rkr, 'Furn/Tables', 0), at(rkr, 'Furn/Chairs', 0), at(rkr, 'Tech/Phones', 0)], [1, 2, 1]);

  // showAs and calc both set: the calc wins.
  const both = grid(penc({ kind: 'running_total', along: 'down' }, { values: [{ column: 'amount', aggregation: 'sum', showAs: 'pct_col', calc: { kind: 'running_total', along: 'down' } }] }));
  ok('pivot: with showAs AND calc, the calc wins and showAs reads value', both.showAs[0] === 'value' && Object.is(at(both, 'Furn/Tables', 0), 40));

  // Year over year on a year-grained dimension: 2023 = 10+20+30 = 60; 2024 = 40+100+200 = 340.
  const yo = grid({ rows: [{ column: 'day', grain: 'year' }], columns: [], values: [{ column: 'amount', aggregation: 'sum', calc: { kind: 'yoy', along: 'down' } }], totals: { rows: false, columns: false, grand: false } });
  ok('pivot yoy: 2024 against 2023 is (340−60)/60', Object.is(at(yo, '2024', 0), (340 - 60) / 60), JSON.stringify(yo.cells));
  ok('pivot yoy: 2023 has no prior year → null', at(yo, '2023', 0) === null);
  const noDate = grid(penc({ kind: 'yoy', along: 'down' }));
  ok('pivot yoy: no grained date dimension → nulls and a warning',
     noDate.cells.every((r) => r.every((v) => v === null)) && (noDate.calcWarnings || []).length === 1);
  const unk = grid(penc({ kind: 'running_total', along: { dimension: 'nope' }, restart: 'ghost' }));
  ok('pivot: an unknown dimension and restart are ignored, with warnings', (unk.calcWarnings || []).length === 2, JSON.stringify(unk.calcWarnings));

  // The chart payload and the caption carry both figures.
  const chart = pivotData.pivotChartData(g);
  const s0 = chart.series[0];
  ok('pivot chart data: a calculated series carries raw and calc', !!s0.calc && Array.isArray(s0.raw) && Object.is(s0.raw[0], 10));
  const cap = captions.tileCaption({ chartType: 'pivot', pivot: g });
  ok('pivot caption: the peak is the largest FIGURE, shown as both',
     cap === '3 rows × 2 columns; Tech · Phones · East is highest at ' + tc.calcLabel('pct_of_total', 200 / 260, 200), cap);

  // withTableCalcs on a pivot reply surfaces what the fold ignored.
  const r = tc.withTableCalcs({ ok: true, data: { labels: [], series: [], pivot: unk }, warnings: [] as string[] }, { category: '', values: [] });
  ok('pivot reply: the fold\'s calc warnings reach the reply', r.warnings.length === 2);
}

// ── 5. The resident path agrees, over the same bytes ─────────────────────────

function testResident(): void {
  let bridge = false;
  try { bridge = duck.isAvailable(); } catch { bridge = false; }
  if (!bridge) { console.log('ok   (skipped) the DuckDB bridge is unavailable — pivot differential not run'); return; }
  const file = path.join(tmpUserData, 'tc.parquet');
  pq.writeTable(file, COLS, ROWS);
  const back = pq.readTable(file, COLS);
  if (!back) { ok('resident: fixture read back', false); return; }
  const cases: Array<[string, PivotEncoding]> = [
    ['pct_of_total down', penc({ kind: 'pct_of_total', along: 'down' }, {}, 'avg')],
    ['pct_of_total down, restart', penc({ kind: 'pct_of_total', along: 'down', restart: 'category' })],
    ['pct_of_total across', penc({ kind: 'pct_of_total', along: 'across' }, {}, 'count')],
    ['running total', penc({ kind: 'running_total', along: 'down', restart: 'category' })],
  ];
  for (const [label, e] of cases) {
    const want = pivotData.buildPivotGrid(back.columns, back.rows, e).grid;
    const got = pivotResident.pivotGridResident({ parquetPath: file, columns: COLS }, e);
    ok(`resident: ${label} matches the JS reference cell for cell`,
       !!got && JSON.stringify(got.cells) === JSON.stringify(want.cells) && got.cells.every((row, i) => same(row, want.cells[i])),
       JSON.stringify({ got: got && got.cells, want: want.cells }));
  }
}

// ── 6. Stored through every sanitizer ────────────────────────────────────────

function testRoundTrip(): void {
  const calc = { kind: 'moving_avg', along: { dimension: 'order_date' }, window: 6 };
  const enc = visuals.sanitizeEncoding({ category: 'order_date', values: [{ column: 'revenue', aggregation: 'sum', calc }] });
  ok('visual: a measure keeps its calc through sanitizeEncoding', JSON.stringify(enc.values[0].calc) === JSON.stringify(calc), JSON.stringify(enc));
  ok('visual: …and again (idempotent)', JSON.stringify(visuals.sanitizeEncoding(JSON.parse(JSON.stringify(enc)))) === JSON.stringify(enc));
  const noCalc = visuals.sanitizeEncoding({ category: 'c', values: [{ column: 'x', aggregation: 'sum' }] });
  ok('visual: no calc stays no calc (no key)', !('calc' in noCalc.values[0]));
  const bad = visuals.sanitizeEncoding({ category: 'c', values: [{ column: 'x', aggregation: 'sum', calc: { kind: 'eval' } }] });
  ok('visual: an unknown calc kind is dropped', !('calc' in bad.values[0]));
  const piv = visuals.sanitizeEncoding({ category: 'c', values: [], pivot: { rows: [{ column: 'c' }], columns: [], values: [{ column: 'x', aggregation: 'sum', calc: { kind: 'running_total', along: 'down', restart: 'c' } }], totals: {} } });
  ok('pivot: a value keeps its calc through sanitizePivot', piv.pivot?.values[0].calc?.kind === 'running_total' && piv.pivot?.values[0].calc?.restart === 'c');
  const card = dashboards.sanitizeCard({ type: 'metric', layout: {}, metric: { datasetId: 'd', column: 'revenue', aggregation: 'sum', calc: { kind: 'pct_of_total', along: 'across' } } });
  ok('KPI card: the metric keeps its calc through sanitizeCard', card?.metric?.calc?.kind === 'pct_of_total', JSON.stringify(card));
}

// ── 7. Display, the renderer's mirror, the caption and the facts ─────────────

function testDisplay(): void {
  format.setFormatPrefs({ locale: 'en-US' });
  const share = tc.calcLabel('pct_of_total', 0.241, 1_250_000);
  ok('label: percent of total names both figures, the raw one in the app\'s compact format',
     share === '24.1% of total · ' + format.formatCompact(1_250_000) && /^24\.1% of total · 1\.\d+M$/.test(share), share);
  ok('label: a rank is "#3"', tc.calcLabel('rank_dense', 3, 10) === '#3 · 10');
  ok('label: an index to one decimal', tc.calcLabel('index', 112.44, null) === '112.4 index');
  ok('label: a difference carries its sign', tc.calcLabel('diff', 1200, 5000).startsWith('+1.2K vs previous'));
  ok('label: a negative percent difference', tc.calcLabel('pct_diff', -0.125) === '-12.5% vs previous');
  ok('label: a null figure is a dash', tc.calcLabel('running_total', null, 5) === '— running total · 5');

  // The renderer's mirror, run in a sandbox on the same shared formatter.
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub', 'calcMenu.js'), 'utf8');
  const ctx = vm.createContext(withT({ OrdFormat: format, window: {}, document: {} }));
  const mirror = vm.runInContext(src + '\n;({ tcCalcLabel, tcCalcParts });', ctx) as {
    tcCalcLabel: (k: string, v: unknown, r?: unknown) => string;
    tcCalcParts: (k: string, v: unknown, r?: unknown) => { value: string; suffix: string; raw: string };
  };
  const values = [0, 0.241, -0.5, 1, 3, 112.44, 1234567, -2500, null, NaN];
  let mismatches = 0;
  const first: string[] = [];
  for (const kind of tc.TABLE_CALC_KINDS) {
    for (const v of values) {
      for (const raw of [null, 0, 1_250_000, -42]) {
        const a = tc.calcLabel(kind, v, raw);
        const b = mirror.tcCalcLabel(kind, v, raw);
        const pa = JSON.stringify(tc.calcParts(kind, v, raw));
        const pb = JSON.stringify(mirror.tcCalcParts(kind, v, raw));
        if (a !== b || pa !== pb) { mismatches += 1; if (first.length < 3) first.push(`${kind}(${v},${raw}): ${a} | ${b}`); }
      }
    }
  }
  ok(`parity: the renderer's tcCalcLabel matches calcLabel on ${tc.TABLE_CALC_KINDS.length * values.length * 4} cases`, mismatches === 0, first.join('; '));

  // Captions say both figures.
  const bar = { labels: ['Technology', 'Furniture'], series: [{ name: 'sum of revenue', values: [0.6, 0.4], raw: [600, 400], calc: { kind: 'pct_of_total' as const, along: 'across' as const } }] };
  const c1 = captions.tileCaption({ chartType: 'column', data: bar });
  ok('caption: a bar chart leads by the calculated figure, with both',
     c1 === 'Technology leads revenue at ' + tc.calcLabel('pct_of_total', 0.6, 600), c1);
  const line = { labels: ['2024-01', '2024-02'], series: [{ name: 'sum of revenue', values: [100, 250], raw: [100, 150], calc: { kind: 'running_total' as const, along: 'across' as const } }] };
  const c2 = captions.tileCaption({ chartType: 'line', data: line });
  ok('caption: a line chart reads at its latest point', c2 === 'Revenue in 2024-02: ' + tc.calcLabel('running_total', 250, 150), c2);
  const ranked = { labels: ['A', 'B'], series: [{ name: 'x', values: [2, 1], raw: [10, 20], calc: { kind: 'rank_dense' as const, along: 'across' as const } }] };
  ok('caption: the smallest rank leads', captions.tileCaption({ chartType: 'bar', data: ranked }) === 'B leads x at #1 · 20');

  // The Assistant's facts bank every calculated figure they print (numberAudit round trip).
  const visual: any = { id: 'v', name: 'Share', chartType: 'column', encoding: { category: 'city', values: [{ column: 'pop', aggregation: 'sum' }] } };
  const viz: any = { data: { labels: ['Paris', 'Berlin'], series: [{ name: 'sum of pop', values: [0.25, 0.75], raw: [100, 300], calc: { kind: 'pct_of_total', along: 'across' } }] }, recommendedShape: 'categorical', warnings: [] };
  const f = facts.visualFacts(visual, 'Cities', viz);
  const selfAudit = audit.auditNumbers(f.text, f.ledger);
  ok('facts: every figure the calculated block prints is in the ledger', selfAudit.ok, JSON.stringify(selfAudit.violations));
  ok('facts: the raw figures are handed over too', /Paris=100, Berlin=300/.test(f.text), f.text);
  ok('facts: an answer citing the share as a percent is clean', audit.auditNumbers('Berlin is 75% of the total.', f.ledger).ok);
  ok('facts: an answer citing the raw figure is clean', audit.auditNumbers('Berlin has 300.', f.ledger).ok);
}

function main(): void {
  testSanitize();
  testKernel();
  testCharts();
  testPivot();
  testResident();
  testRoundTrip();
  testDisplay();
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(failureCount() === 0 ? '\nAll table-calculation checks passed.' : '\ntable-calculation checks FAILED.');
  process.exit(failureCount() ? 1 : 0);
}

main();
