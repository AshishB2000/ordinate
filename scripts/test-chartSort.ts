// Sort-by-value reorders the charts it should, and never changes a FIGURE.
//
// WHY IT EXISTS. `canSort` in chartRender.ts was
// `(chartType === 'bar' && …) || isRound`, and `isRound` is true for a GAUGE —
// a gauge is drawn as a Chart.js doughnut, so it inherits every round-family
// branch unless one says otherwise. (The same inheritance is why #145 had to
// exclude it from the `roundLabels` plugin.)
//
// The consequence is not the cosmetic reorder it sounds like. chartDatasets
// builds a gauge's two slices ITSELF, from `series[0].values.find(isNumber)` —
// the FIRST numeric value — so reordering the categories underneath changes
// WHICH NUMBER THE GAUGE SHOWS. Measured on 120/340/80 before the fix:
//
//     no sort -> 120 (first)   asc -> 80 (smallest)   desc -> 340 (largest)
//
// …with the scale moving under it too, since gmax is derived from the value. In
// an app whose first principle is that it does the math and never invents a
// figure, a display control that silently swaps which figure is displayed is a
// correctness bug, not a styling one.
//
// It was latent: `sortableType` (now in fmtSort.ts) excludes `gauge`, so the
// Sort field is hidden and the UI cannot set `overrides.sort`. buildChart is
// called from six places though, and nothing but that hidden field stood between
// a gauge and a wrong number. These checks make the guard the rule rather than
// the UI's good manners.
//
// HOW. The vm-sandbox harness scripts/test-chartLegend.ts introduced: the emitted
// renderer siblings run in a `vm` (classic global-scope scripts, nothing to
// import), the real chart.umd.js supplies genuine statics, and only the
// constructor is a recorder since there is no canvas. Assertions read the config
// buildChart actually produced.
//
//   npm run build:ts && node scripts/test-chartSort.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish, failureCount } from './selfcheck';

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const HUB = path.join(__dirname, '..', 'renderer', 'hub');
const CHART_UMD = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const CHART_SCRIPTS = [
  'chartTraits.js', 'chartPalette.js', 'chartTypeSpec.js', 'chartShapes.js', 'chartFamiliesExtra.js', 'chartFamiliesPlugins.js',
  'chartValueLabels.js', 'chartAnnotations.js', 'chartDatasets.js', 'chartScales.js', 'chartRender.js', 'calcMenu.js',
];
const THEME: Record<string, string> = {
  '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6',
  '--chart-4': '#6366f1', '--chart-5': '#64748b',
  '--chart-6': '#b45309', '--chart-7': '#be185d', '--chart-8': '#4d7c0f',
  '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff',
  '--text-strong': '#111827', '--font-ui': 'Inter, system-ui, sans-serif',
  '--accent': '#2563eb', '--ok': '#16a34a', '--error': '#dc2626',
};
// Stubs, not copies: nothing asserted here is a formatted number — chartSpec is
// where the formatters are pinned.
const PRELUDE = `
function _fmtVal(v) { return v == null ? '' : String(v); }
function fmtWith(v) { return v == null ? '' : String(v); }
function histogramBins(values) { return { labels: values.map(String), counts: values.map(function(){return 1;}) }; }
`;

const recorded: any[] = [];
const sandbox: Record<string, any> = { console };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.matchMedia = () => ({ matches: false });
sandbox.document = { documentElement: {}, createElement: () => ({ style: {}, getContext: () => null }) };
sandbox.requestAnimationFrame = (f: Function) => f;
sandbox.cancelAnimationFrame = () => {};
sandbox.getComputedStyle = () => ({ getPropertyValue: (n: string) => THEME[n] || '' });
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(CHART_UMD, 'utf8'), sandbox, { filename: 'chart.umd.js' });
const RealChart = sandbox.Chart;
function Rec(this: any, _canvas: unknown, config: any) { recorded.push(config); this.config = config; }
(Rec as any).defaults = RealChart.defaults;
(Rec as any).overrides = RealChart.overrides;
(Rec as any).register = () => {};
sandbox.Chart = Rec;
sandbox.ChartBoxPlot = undefined;

const source = PRELUDE + '\n' + CHART_SCRIPTS
  .map((f) => '\n// ==== ' + f + ' ====\n' + fs.readFileSync(path.join(HUB, f), 'utf8'))
  .join('\n');
const api: { buildChart: Function } = vm.runInContext(
  source + '\n;({ buildChart: buildChart });', sandbox, { filename: 'chart-family.js' });

/** Build `type` with `sort` and hand back the config. Fresh data each call —
 *  buildChart reorders in place, so a shared fixture would leak between cases. */
function build(type: string, sort?: string): any {
  recorded.length = 0;
  const data = {
    labels: ['North', 'South', 'East'],
    series: [{ name: 'sum of amount', values: [120, 340, 80] }],
  };
  api.buildChart({}, data, type, sort ? { sort } : {});
  return recorded[0];
}

// ── THE BUG: a gauge's FIGURE must not move ────────────────────────────────
// A gauge's first slice is the value it displays. Before the fix these were
// 120 / 80 / 340.
const gaugeValue = (sort?: string): number => build('gauge', sort).data.datasets[0].data[0];
const unsorted = gaugeValue();
ok('a gauge shows the value its encoding selected', unsorted === 120, String(unsorted));
ok('…and `asc` does not change which number that is', gaugeValue('asc') === unsorted,
   String(gaugeValue('asc')));
ok('…nor does `desc`', gaugeValue('desc') === unsorted, String(gaugeValue('desc')));
// The scale is derived from the value, so it moved too. Pin it as well.
const gaugeMax = (sort?: string): number => {
  const d = build('gauge', sort).data.datasets[0].data;
  return d[0] + d[1];
};
ok('…and the gauge scale stays put with it',
   gaugeMax('asc') === gaugeMax() && gaugeMax('desc') === gaugeMax(), String(gaugeMax('desc')));

// ── THE OTHER HALF: sorting must still work where it always did ────────────
// A guard that quietly disabled sorting for pie/donut/bar would pass every
// assertion above while breaking a real feature.
const labelsOf = (type: string, sort?: string): string[] => build(type, sort).data.labels;
for (const type of ['donut', 'pie', 'bar', 'column']) {
  ok(`${type}: unsorted keeps the data's own order`,
     labelsOf(type).join() === 'North,South,East', labelsOf(type).join());
  ok(`${type}: asc orders by value`,
     labelsOf(type, 'asc').join() === 'East,North,South', labelsOf(type, 'asc').join());
  ok(`${type}: desc orders by value`,
     labelsOf(type, 'desc').join() === 'South,North,East', labelsOf(type, 'desc').join());
}

// ── And the types that must never sort, still never do ─────────────────────
// A time axis or a fixed sequence would be scrambled by it.
for (const type of ['line', 'area', 'funnel']) {
  ok(`${type}: keeps its natural order under desc`,
     labelsOf(type, 'desc').join() === 'North,South,East', labelsOf(type, 'desc').join());
}
// A waterfall's order is its story (a total sits where it sits), so Sort never
// reaches it — and a Pareto sorts ITSELF descending, whatever `asc` asks.
ok('waterfall: keeps its natural order under asc (plus its closing Total)',
   labelsOf('waterfall', 'asc').join() === 'North,South,East,Total', labelsOf('waterfall', 'asc').join());
ok('pareto: always descending, even under asc',
   labelsOf('pareto', 'asc').join() === 'South,North,East', labelsOf('pareto', 'asc').join());
ok('bullet: sorts like a bar', labelsOf('bullet', 'desc').join() === 'South,North,East');

// ── The UI gate that made this latent is still in place ────────────────────
// `sortableType` in fmtSort.ts is why nobody could reach the bug from the
// Customize menu. It is a SECOND line of defence, not the fix — but if it ever
// gained `gauge` while the guard above was absent, the bug would be live. Pin
// the pair so they cannot drift apart silently.
// The Sort control moved from the ⋯ menu's quick fields into the Format panel
// (fmtSort.ts), and the list moved with it.
const controls = fs.readFileSync(path.join(HUB, 'fmtSort.ts'), 'utf8');
const sortable = /const sortableType = \[([^\]]*)\]/.exec(controls);
ok('fmtSort declares a sortableType list', Boolean(sortable));
ok('…which does not offer Sort for a gauge',
   Boolean(sortable) && sortable![1].indexOf("'gauge'") < 0, sortable ? sortable[1] : '(none)');

finish();
if (failureCount()) process.exit(1);
