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

/**
 * PARITY with the renderer's `_fmtVal`.
 *
 * captions.ts cannot import it — `_fmtVal` is a top-level function in a classic
 * <script>, with no module boundary to cross — so the copy is pinned here
 * instead: the four branch expressions are lifted out of both sources as text,
 * whitespace-normalized, and required to match as sets. A threshold or a suffix
 * moving on either side fails this, which is the whole point.
 */
const REPO = path.resolve(__dirname, '..');
const squash = (s: string) => s.replace(/\s+/g, '');
const branches = (src: string, fnName: string): string[] => {
  const at = src.indexOf('function ' + fnName + '(');
  const body = at < 0 ? '' : src.slice(at, src.indexOf('\n}', at));
  return (body.match(/if \(Math\.abs\(v\)[^\n]*/g) || []).map(squash);
};
const hubBranches = branches(fs.readFileSync(path.join(REPO, 'renderer/hub/hub.ts'), 'utf8'), '_fmtVal');
const capBranches = branches(fs.readFileSync(path.join(REPO, 'src/analysis/captions.ts'), 'utf8'), 'compact');
ok('compact() and the renderer\'s _fmtVal still agree, branch for branch',
  hubBranches.length === 3 && capBranches.length === 3
  && hubBranches.every((b, i) => b === capBranches[i]),
  JSON.stringify({ hubBranches, capBranches }));

if (!failureCount()) console.log('\nAll caption checks passed.');
finish();
