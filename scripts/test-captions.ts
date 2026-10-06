// Captions — EXACT-STRING tests, one block per chart family.
//
// Captions are the one place in a report where the app writes English about a
// figure, so "it produced something" is not a passing bar: every assertion here
// pins the WHOLE sentence. That is only a reasonable thing to demand because
// src/analysis/captions.ts is pure and takes already-computed figures — there
// is no clock, no locale branch and no model in the path.
//
// Three groups: the five named families on fixtures from the spec, the edge
// cases each frame has to survive (ties, a single value, an empty tile, a zero
// baseline, a negative part-to-whole), and the compact-number parity check
// against the renderer's `_fmtVal`, which is the one figure formatter this file
// is allowed to have a second copy of.

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';
import { tileCaption, captionFamily, compact } from '../src/analysis/captions';
import { waterfallFigures, paretoFigures } from '../src/analysis/chartFigures';
import { golden } from './golden';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const s1 = (name: string, values: (number | null)[]) => [{ name, values }];

// ── bar / column ─────────────────────────────────────────────────────────────

ok('bar: leader + multiple of the runner-up',
  tileCaption({
    chartType: 'column',
    data: { labels: ['Technology', 'Furniture', 'Office'], series: s1('sum of revenue', [3_800_000, 1_583_333, 900_000]) },
  }) === 'Technology leads revenue at 3.8M, 2.4× Furniture',
  tileCaption({ chartType: 'column', data: { labels: ['Technology', 'Furniture', 'Office'], series: s1('sum of revenue', [3_800_000, 1_583_333, 900_000]) } }));

ok('bar: leader is found by VALUE, not by position',
  tileCaption({
    chartType: 'bar',
    data: { labels: ['Office', 'Technology'], series: s1('sum of revenue', [1_000_000, 4_000_000]) },
  }) === 'Technology leads revenue at 4.0M, 4.0× Office');

ok('bar: a stacked chart reads as the STACK TOTAL, not series one',
  tileCaption({
    chartType: 'stacked_column',
    data: {
      labels: ['East', 'West'],
      series: [{ name: 'East region', values: [10, 400] }, { name: 'West region', values: [90, 100] }],
    },
  }) === 'West leads the total at 500, 5.0× East');

ok('bar: two-way tie gets its own frame, never "1.0×"',
  tileCaption({
    chartType: 'column',
    data: { labels: ['A', 'B', 'C'], series: s1('sum of revenue', [500, 500, 100]) },
  }) === 'A and B tie for the lead in revenue at 500');

ok('bar: three-way tie is counted, not listed',
  tileCaption({
    chartType: 'column',
    data: { labels: ['A', 'B', 'C'], series: s1('sum of revenue', [7, 7, 7]) },
  }) === 'three categories tie for the lead in revenue at 7');

ok('bar: a single category states itself',
  tileCaption({
    chartType: 'column',
    data: { labels: ['Technology'], series: s1('sum of revenue', [3_800_000]) },
  }) === 'Technology is the only category, revenue 3.8M');

ok('bar: a runner-up at zero drops the ratio rather than dividing by it',
  tileCaption({
    chartType: 'column',
    data: { labels: ['A', 'B'], series: s1('sum of revenue', [40, 0]) },
  }) === 'A leads revenue at 40');

ok('bar: an all-null tile says so',
  tileCaption({ chartType: 'column', data: { labels: ['A', 'B'], series: s1('sum of revenue', [null, null]) } })
  === 'No data to summarize');

ok('bar: the aggregation prefix comes off the series name',
  tileCaption({ chartType: 'column', data: { labels: ['A', 'B'], series: s1('avg of margin', [9, 3]) } })
  === 'A leads margin at 9, 3.0× B');

ok('bar: a count series keeps its bare column name',
  tileCaption({ chartType: 'column', data: { labels: ['A', 'B'], series: s1('orders', [9, 3]) } })
  === 'A leads orders at 9, 3.0× B');

// ── line / area ──────────────────────────────────────────────────────────────

ok('line: direction, percentage, span and an interior peak',
  tileCaption({
    chartType: 'line',
    data: {
      labels: ['Jan 2023', 'Nov 2023', 'Dec 2024'],
      series: s1('sum of revenue', [100_000, 342_700, 141_000]),
    },
  }) === 'Revenue rose 41% from Jan 2023 to Dec 2024, peaking at 342.7K in Nov 2023',
  tileCaption({ chartType: 'line', data: { labels: ['Jan 2023', 'Nov 2023', 'Dec 2024'], series: s1('sum of revenue', [100_000, 342_700, 141_000]) } }));

ok('line: a peak at the END is not restated',
  tileCaption({
    chartType: 'area',
    data: { labels: ['Jan', 'Feb', 'Mar'], series: s1('sum of revenue', [100, 150, 200]) },
  }) === 'Revenue rose 100% from Jan to Mar');

ok('line: a fall is a fall',
  tileCaption({
    chartType: 'line',
    data: { labels: ['Jan', 'Feb'], series: s1('sum of revenue', [200, 50]) },
  }) === 'Revenue fell 75% from Jan to Feb');

ok('line: flat to the rounded percent reads as steady',
  tileCaption({
    chartType: 'line',
    data: { labels: ['Jan', 'Feb'], series: s1('sum of revenue', [1000, 1002]) },
  }) === 'Revenue held steady from Jan to Feb');

ok('line: a zero baseline drops the percentage instead of printing Infinity',
  tileCaption({
    chartType: 'line',
    data: { labels: ['Jan', 'Feb'], series: s1('sum of revenue', [0, 500]) },
  }) === 'Revenue rose to 500 from Jan to Feb');

ok('line: one point is a reading, not a trend',
  tileCaption({
    chartType: 'line',
    data: { labels: ['Nov 2023'], series: s1('sum of revenue', [342_700]) },
  }) === 'Revenue was 342.7K in Nov 2023');

ok('line: empty says so',
  tileCaption({ chartType: 'line', data: { labels: [], series: [] } }) === 'No data to summarize');

// ── KPI row ──────────────────────────────────────────────────────────────────

ok('kpi: the row is the caption',
  tileCaption({
    kpis: [
      { label: 'Revenue', value: 5_200_000 }, { label: 'Profit', value: 686_200 },
      { label: 'Units', value: 19_400 }, { label: 'Orders', value: 5_000 },
    ],
  }) === 'Revenue 5.2M · Profit 686.2K · Units 19.4K · Orders 5.0K',
  tileCaption({ kpis: [{ label: 'Revenue', value: 5_200_000 }, { label: 'Profit', value: 686_200 }, { label: 'Units', value: 19_400 }, { label: 'Orders', value: 5_000 }] }));

ok('kpi: an unavailable figure keeps its place as an em dash',
  tileCaption({ kpis: [{ label: 'Revenue', value: 5_200_000 }, { label: 'Profit', value: null }] })
  === 'Revenue 5.2M · Profit —');

ok('kpi: no metrics says so',
  tileCaption({ kpis: [] }) === 'No metrics on this sheet');

// ── map ──────────────────────────────────────────────────────────────────────

ok('map: the leading region and its figure',
  tileCaption({
    chartType: 'map_choropleth',
    data: { labels: ['California', 'Texas'], series: s1('sum of profit', [85_400, 40_000]) },
    geo: { items: [{ name: 'California', value: 85_400 }, { name: 'Texas', value: 40_000 }] },
  }) === 'California leads profit at 85.4K, 2.1× Texas');

ok('map: one region reads as a region, not a category',
  tileCaption({
    chartType: 'map_bubble',
    data: { labels: ['California'], series: s1('sum of profit', [85_400]) },
    geo: { items: [{ name: 'California', value: 85_400 }] },
  }) === 'California is the only region, profit 85.4K');

ok('map: no resolved regions says so',
  tileCaption({ chartType: 'map_choropleth', data: { labels: [], series: [] }, geo: { items: [] } })
  === 'No data to summarize');

// ── donut / pie ──────────────────────────────────────────────────────────────

ok('part: slice count in words, then the biggest share',
  tileCaption({
    chartType: 'donut',
    data: { labels: ['Technology', 'Furniture', 'Office'], series: s1('sum of revenue', [73, 17, 10]) },
  }) === 'Three categories; Technology is 73%');

ok('part: eleven slices counts in digits',
  tileCaption({
    chartType: 'pie',
    data: {
      labels: Array.from({ length: 11 }, (_, i) => 'c' + i),
      series: s1('sum of revenue', Array.from({ length: 11 }, (_, i) => (i === 0 ? 50 : 5))),
    },
  }) === '11 categories; c0 is 50%');

ok('part: one slice is the whole thing',
  tileCaption({ chartType: 'pie', data: { labels: ['Technology'], series: s1('sum of revenue', [42]) } })
  === 'One category; Technology is 100%');

ok('part: a non-positive total has no share, so it falls back to comparing',
  tileCaption({ chartType: 'pie', data: { labels: ['A', 'B'], series: s1('sum of revenue', [-10, -20]) } })
  === 'A leads revenue at -10');

// ── the families that are not one of the five ────────────────────────────────

ok('scatter: a cloud gets its count and range',
  tileCaption({ chartType: 'scatter', data: { labels: ['a', 'b', 'c'], series: s1('sum of revenue', [10, 500, 90]) } })
  === '3 points, revenue from 10 to 500');

ok('table: the honest sentence is a count',
  tileCaption({ chartType: 'table', data: { labels: ['a', 'b'], series: s1('sum of revenue', [10, 20]) } })
  === 'Revenue across 2 categories, totalling 30');

ok('gauge: one figure is one figure',
  tileCaption({ chartType: 'gauge', data: { labels: ['Total'], series: s1('sum of revenue', [1_200]) } })
  === 'Revenue is 1.2K');

ok('a garbage input never throws and never returns empty',
  tileCaption({} as never) === 'No data to summarize');

// ── families ─────────────────────────────────────────────────────────────────

ok('every family maps as documented', [
  captionFamily('pct_stacked_bar') === 'bar',
  captionFamily('stacked_area') === 'line',
  captionFamily('donut') === 'part',
  captionFamily('map_bubble') === 'map',
  captionFamily('bubble') === 'point',
  captionFamily('sankey') === 'other',
  captionFamily(undefined) === 'other',
].every(Boolean));

// ── number formatting ────────────────────────────────────────────────────────

ok('compact covers the four bands', [
  compact(2_400_000_000) === '2.4B',
  compact(3_800_000) === '3.8M',
  compact(342_700) === '342.7K',
  compact(5_000) === '5.0K',
  compact(999) === (999).toLocaleString(),
  compact(-3_800_000) === '-3.8M',
  compact(null) === '',
  compact(Infinity) === '',
].every(Boolean));

// ── pivot ───────────────────────────────────────────────────────────────────
//
// A pivot's sentence is about the GRID: how big it is, and which CELL is
// biggest. The peak is read off LEAF rows only — a subtotal is larger than its
// own children by construction and would win every time, which would make the
// sentence name a row the reader can collapse.
const pivotGrid = (over: Record<string, unknown> = {}): never => ({
  rowHeaders: [['Technology'], ['Technology', 'Phones'], ['Furniture'], ['Furniture', 'Chairs']],
  colHeaders: [['West'], ['East']],
  cells: [[1_100_000, 900_000], [1_100_000, 900_000], [400_000, 300_000], [400_000, 300_000]],
  rowKinds: ['subtotal', 'leaf', 'subtotal', 'leaf'],
  rowTotals: null, colTotals: null, grand: null,
  valueNames: ['sum of revenue'], valueCount: 1,
  showAs: ['value'], formats: [''], conditional: [], sort: null,
  rowGroupCount: 24, colGroupCount: 3, truncated: false,
  ...over,
} as never);

ok('pivot: size first, then the biggest LEAF cell by its full path',
  tileCaption({ chartType: 'pivot', pivot: pivotGrid() })
    === '24 rows × 3 columns; Technology · Phones · West is highest at 1.1M',
  tileCaption({ chartType: 'pivot', pivot: pivotGrid() }));

ok('pivot: one row and one column are singular',
  tileCaption({
    chartType: 'pivot',
    pivot: pivotGrid({
      rowHeaders: [['Only']], cells: [[42]], rowKinds: ['leaf'], colHeaders: [['West']],
      rowGroupCount: 1, colGroupCount: 1,
    }),
  }) === '1 row × 1 column; Only · West is highest at 42');

ok('pivot: a grid of nothing but nulls says so rather than naming a peak',
  tileCaption({
    chartType: 'pivot',
    pivot: pivotGrid({ rowHeaders: [['A']], cells: [[null, null]], rowKinds: ['leaf'], rowGroupCount: 1 }),
  }) === '1 row × 3 columns; no figures to compare');

ok('pivot: an empty grid falls back to the shared nothing-to-say sentence',
  tileCaption({ chartType: 'pivot', pivot: pivotGrid({ rowGroupCount: 0 }) }) === 'No data to summarize');

ok('pivot: and a pivot with no grid at all does too',
  tileCaption({ chartType: 'pivot' }) === 'No data to summarize');

ok('captionFamily knows the pivot family', captionFamily('pivot') === 'pivot');

// ONE formatter: captions.compact and the web chart engine's fmtVal both call
// src/app/format.ts's formatCompact, so a caption and its card print one number.
{
  const { formatCompact } = require('../src/app/format') as typeof import('../src/app/format');
  const REPO = path.resolve(__dirname, '..');
  const webSrc = fs.readFileSync(path.join(REPO, 'web/src/charts/format.ts'), 'utf8');
  const at = webSrc.indexOf('function fmtVal(');
  ok('the web chart engine\'s fmtVal is OrdFormat.formatCompact',
    at >= 0 && /return OrdFormat\.formatCompact\(v\);/.test(webSrc.slice(at, webSrc.indexOf('\n}', at))));
  const cases = [0, 12.25, 999, 1500, 999_999, 5_194_598.73, 4.5e9, -1500];
  ok('compact() is formatCompact', cases.every((v) => compact(v) === formatCompact(v)),
    JSON.stringify(cases.map((v) => [compact(v), formatCompact(v)])));
}

// ── waterfall · Pareto · bullet · radar · calendar ───────────────────────────

ok('waterfall: steps, span and the largest step (the spec sentence)',
  tileCaption({
    chartType: 'waterfall',
    data: { labels: ['Total 2023', 'Technology', 'Furniture', 'Office', 'Other'],
            series: s1('sum of revenue', [4_100_000, 1_300_000, -400_000, 100_000, 100_000]) },
  }) === 'Four steps take revenue from 4.1M to 5.2M; the largest is Technology at +1.3M',
  tileCaption({ chartType: 'waterfall', data: { labels: ['Total 2023', 'Technology', 'Furniture', 'Office', 'Other'], series: s1('sum of revenue', [4_100_000, 1_300_000, -400_000, 100_000, 100_000]) } }));

ok('waterfall: with no opening total it starts from 0, and a fall keeps its sign',
  tileCaption({ chartType: 'waterfall', data: { labels: ['A', 'B', 'C'], series: s1('sum of profit', [500, -900, 100]) } })
  === 'Three steps take profit from 0 to -300; the largest is B at -900');

ok('waterfall: the override names an opening total the label does not',
  tileCaption({
    chartType: 'waterfall',
    data: { labels: ['Opening', 'Q1'], series: s1('sum of cash', [1_000, 250]) },
    overrides: { waterfallTotals: ['Opening'] },
  }) === 'One step takes cash from 1.0K to 1.3K: Q1 at +250');

ok('waterfall: two series are a bridge from one sum to the other',
  tileCaption({
    chartType: 'waterfall',
    data: { labels: ['East', 'West'], series: [{ name: '2023', values: [100, 300] }, { name: '2024', values: [180, 250] }] },
  }) === 'Two steps take the total from 400 to 430; the largest is East at +80');

ok('pareto: how many categories make 80% (the spec sentence)',
  tileCaption({
    chartType: 'pareto',
    data: { labels: ['A', 'B', 'C', 'D', 'E'], series: s1('sum of revenue', [30, 20, 5, 35, 10]) },
  }) === 'Three categories make 80% of revenue');

ok('pareto: one dominant category is named',
  tileCaption({ chartType: 'pareto', data: { labels: ['A', 'B', 'C'], series: s1('sum of revenue', [5, 90, 5]) } })
  === 'B alone makes 80% of revenue');

ok('pareto: when every category is needed, it says so',
  tileCaption({ chartType: 'pareto', data: { labels: ['A', 'B', 'C', 'D'], series: s1('sum of revenue', [25, 25, 25, 25]) } })
  === 'It takes all four categories to make 80% of revenue');

ok('pareto: nothing positive has no 80% — it falls back to comparing',
  tileCaption({ chartType: 'pareto', data: { labels: ['A', 'B'], series: s1('sum of revenue', [0, 0]) } })
  === 'A and B tie for the lead in revenue at 0');

ok('bullet: a second measure is the target, per category',
  tileCaption({
    chartType: 'bullet',
    data: { labels: ['Technology', 'Furniture', 'Office'],
            series: [{ name: 'sum of revenue', values: [128, 95, 101] }, { name: 'sum of target', values: [100, 100, 100] }] },
  }) === 'Two of three categories reach target; Technology leads at 128%');

ok('bullet: none reaching it names the closest',
  tileCaption({
    chartType: 'bullet',
    data: { labels: ['A', 'B', 'C'], series: s1('sum of revenue', [50, 94, 10]) },
    overrides: { bulletTarget: 100 },
  }) === 'None of three categories reach target; B is closest at 94%');

ok('bullet: one row reads as one figure against its target',
  tileCaption({ chartType: 'bullet', data: { labels: ['Revenue'], series: s1('sum of revenue', [5_200_000]) },
                overrides: { bulletTarget: 5_000_000 } })
  === 'Revenue is at 104% of its 5.0M target');

ok('bullet: no target at all says what the bars say',
  tileCaption({ chartType: 'bullet', data: { labels: ['A', 'B'], series: s1('sum of revenue', [40, 10]) } })
  === 'A leads revenue at 40, 4.0× B');

ok('radar: who wins the most axes, on raw figures',
  tileCaption({
    chartType: 'radar',
    data: { labels: ['West', 'East'], series: [
      { name: 'sum of revenue', values: [900, 400] }, { name: 'sum of profit', values: [90, 120] },
      { name: 'sum of units', values: [30, 20] }, { name: 'avg of discount', values: [0.2, 0.1] },
    ] },
  }) === 'West leads on three of four measures');

ok('radar: a clean sweep is "all"',
  tileCaption({ chartType: 'radar', data: { labels: ['A', 'B'], series: [
    { name: 'x', values: [2, 1] }, { name: 'y', values: [2, 1] }, { name: 'z', values: [2, 1] },
  ] } }) === 'A leads on all three measures');

ok('calendar: the peak day and the span',
  tileCaption({ chartType: 'calendar', data: { labels: ['2024-11-28', '2024-11-29', '2024-11-30'],
                                               series: s1('sum of revenue', [5_000, 12_300, 800]) } })
  === 'Revenue peaked at 12.3K on 2024-11-29, across 3 days');

ok('the five newer ids map to their own families', [
  captionFamily('waterfall') === 'waterfall', captionFamily('pareto') === 'pareto',
  captionFamily('bullet') === 'bullet', captionFamily('radar') === 'radar', captionFamily('calendar') === 'calendar',
].every(Boolean));

/**
 * DIFFERENTIAL: the caption's figures against the chart's.
 *
 * A caption is written in MAIN (src/analysis/chartFigures.ts) about a picture
 * the desktop drew from its chartShapes.js — two implementations of one piece
 * of arithmetic, so the house rule applies: run both over the same fixtures and
 * require Object.is on every figure the sentence states. The desktop's answers
 * were recorded when it went (T8.1): scripts/fixtures/golden/captions.json. The
 * web chart engine is pinned to the same desktop shapes by
 * web/src/charts/legacy.test.ts.
 */
type Steps = { from: number; to: number; kind: string[] };
type Pareto = { count80: number; labels: any[] };
const G = golden<{ waterfall: Record<string, Steps>; pareto: Record<string, Pareto> }>('captions');
const shapes = {
  waterfallSteps: (name: string): Steps => G.waterfall[name],
  paretoShape: (name: string): Pareto => G.pareto[name],
};
const WF: Array<{ name: string; data: any; totals?: string[] }> = [
  { name: 'plain steps', data: { labels: ['a', 'b', 'c'], series: s1('v', [0.1, 0.2, 0.3]) } },
  { name: 'opening total', data: { labels: ['Total', 'x', 'y'], series: s1('v', [1e6 / 3, -123.45, 7e-3]) } },
  { name: 'empty subtotal mid-way', data: { labels: ['a', 'Subtotal', 'b', 'Grand total'], series: s1('v', [5, null, 2, null]) } },
  { name: 'override total', data: { labels: ['Open', 'a', 'b'], series: [{ name: 'v', values: [10, 'x', -3] }] }, totals: ['Open'] },
  { name: 'bridge', data: { labels: ['e', 'w', 'Total', 'n'], series: [
    { name: 'p', values: [0.1, 0.7, 99, null] }, { name: 'q', values: [0.3, null, 1, 0.2] }] } },
  { name: 'empty', data: { labels: [], series: s1('v', []) } },
];
ok('the waterfall fixture holds exactly these cases', JSON.stringify(WF.map((f) => f.name)) === JSON.stringify(Object.keys(G.waterfall)));
for (const f of WF) {
  const main = waterfallFigures(f.data, f.totals);
  const drawn = shapes.waterfallSteps(f.name);
  const steps = drawn.kind.filter((k) => k === 'up' || k === 'down').length;
  ok(`differential waterfall (${f.name}): same start, end and step count`,
     Object.is(main.from, drawn.from) && Object.is(main.to, drawn.to) && main.steps.length === steps,
     JSON.stringify({ main: [main.from, main.to, main.steps.length], drawn: [drawn.from, drawn.to, steps] }));
}
const PARETO: Array<{ name: string; data: any }> = [
  { name: 'spread', data: { labels: ['a', 'b', 'c', 'd', 'e'], series: s1('v', [30, 20, 5, 35, 10]) } },
  { name: 'exact 80 in floats', data: { labels: ['a', 'b', 'c'], series: s1('v', [0.1, 0.7, 0.2]) } },
  { name: 'ties', data: { labels: ['a', 'b', 'c', 'd'], series: s1('v', [2, 2, 2, 2]) } },
  { name: 'negatives and nulls', data: { labels: ['a', 'b', 'c', 'd'], series: s1('v', [-5, null, 3, 1]) } },
  { name: 'all zero', data: { labels: ['a', 'b'], series: s1('v', [0, 0]) } },
  { name: 'long tail', data: { labels: Array.from({ length: 40 }, (_, i) => 'c' + i),
                               series: s1('v', Array.from({ length: 40 }, (_, i) => 1 / (i + 1))) } },
];
ok('the Pareto fixture holds exactly these cases', JSON.stringify(PARETO.map((f) => f.name)) === JSON.stringify(Object.keys(G.pareto)));
for (const f of PARETO) {
  const main = paretoFigures(f.data);
  const drawn = shapes.paretoShape(f.name);
  ok(`differential pareto (${f.name}): same 80% count and the same leader`,
     Object.is(main.count80, drawn.count80) && (drawn.labels.length === 0 || main.top === String(drawn.labels[0])),
     JSON.stringify({ main, drawn: [drawn.count80, drawn.labels[0]] }));
}

if (!failureCount()) console.log('\nAll caption checks passed.');
finish();
