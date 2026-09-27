// Self-check for buildChart() — the Chart.js CONFIG it hands to `new Chart()`,
// captured for every chart id in VIZ_LABELS under three override sets.
//
// WHY IT EXISTS. chartRender.ts carried a 999-line buildChart() whose per-family
// blocks all read the same locals, and the file header said the split was "a
// design change with real behaviour risk, not a move". This is the check that
// paid for that risk: the config is a pure function of (data, type, overrides)
// plus the theme tokens, so it can be captured exactly and frozen. A refactor
// that changes ONE colour, ONE callback body or ONE axis key fails here.
//
// It does NOT mirror the source the way test-more-charts.ts has to. The emitted
// siblings are EXECUTED in a `vm` sandbox — chartTraits.js, chartPalette.js and
// the chart-render family — with a recording stand-in for the Chart.js
// constructor, so the real functions build the real config. Only the browser
// surface buildChart touches is stubbed, and every stub is deterministic:
//
//   getComputedStyle → a fixed theme token table (no DOM, no locale)
//   matchMedia       → prefers-reduced-motion: false
//   _fmtVal/fmtWith/histogramBins → hub.js formatters, restated here WITHOUT
//       toLocaleString(), which is locale- and ICU-version-dependent and would
//       make the snapshot machine-specific. They are inputs to the capture, not
//       its subject; what is frozen is the config buildChart builds AROUND them.
//
// HOW IT IS FROZEN. Each config is serialised deterministically — keys sorted,
// functions kept as their source text (so a plugin's drawing code, an axis tick
// callback and a scriptable gradient are all inside the comparison), undefined
// preserved — and hashed. GOLDEN below is those hashes, taken from develop
// BEFORE the split. On a mismatch the full serialisation of the failing case is
// written to a temp file and the path printed, so the break is diffable.
//
// A hash is only honest if the capture really ran: `chart` must be non-null and
// a config must have been recorded for every case, or the suite fails loudly
// instead of comparing 84 identical hashes of `null`.
//
//   npm run build:ts && node scripts/test-chartSpec.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as crypto from 'crypto';

const HUB = path.join(__dirname, '..', 'renderer', 'hub');

// The chart-render family, in index.html's dependency order. A file added to
// the split must be added here too — otherwise its symbols are missing and the
// sandbox throws at build time rather than passing green and inert.
const CHART_SCRIPTS = [
  'chartTraits.js',
  'chartPalette.js',
  'chartTypeSpec.js',
  'chartShapes.js',
  'chartFamiliesExtra.js',
  'chartFamiliesPlugins.js',
  'chartValueLabels.js',
  'chartDatasets.js',
  'chartScales.js',
  'chartRender.js',
];

// Fixed theme tokens. Real values from the light theme; the point is only that
// they are the SAME on every machine and every run.
const THEME: Record<string, string> = {
  '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6',
  '--chart-4': '#6366f1', '--chart-5': '#64748b',
  '--chart-6': '#b45309', '--chart-7': '#be185d', '--chart-8': '#4d7c0f',
  '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff',
  '--text-strong': '#111827', '--font-ui': 'Inter, system-ui, sans-serif',
  '--accent': '#2563eb', '--ok': '#16a34a', '--error': '#dc2626',
};

// hub.js's formatters, with toLocaleString() replaced by a fixed grouping so the
// capture is machine-independent (see the header).
const PRELUDE = `
function _group(n) {
  const neg = n < 0; const a = Math.abs(n);
  const i = Math.floor(a); const f = a - i;
  let s = String(i).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  if (f) s += String(Math.round(f * 1e6) / 1e6).slice(1);
  return (neg ? '-' : '') + s;
}
function _fmtVal(v) {
  if (v == null) return '';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return _group(v);
}
function fmtWith(v, mode) {
  if (v == null) return '';
  if (typeof v !== 'number') return String(v);
  switch (mode) {
    case 'plain':     return _group(v);
    case 'thousands': return _group(Math.round(v));
    case 'compact':   return _fmtVal(v);
    case 'percent':   return _group(Math.round(v * 100 * 100) / 100) + '%';
    case 'currency':  return '$' + _group(Math.round(v));
    default:          return _fmtVal(v);
  }
}
function histogramBins(values) {
  if (!values.length) return { labels: [], counts: [] };
  const min = Math.min.apply(null, values), max = Math.max.apply(null, values);
  if (min === max) return { labels: [_fmtVal(min)], counts: [values.length] };
  const k = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(values.length))));
  const width = (max - min) / k;
  const counts = new Array(k).fill(0);
  values.forEach(function (v) {
    let idx = Math.floor((v - min) / width);
    if (idx >= k) idx = k - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  });
  const labels = counts.map(function (_, i) {
    return _fmtVal(min + i * width) + '–' + _fmtVal(min + (i + 1) * width);
  });
  return { labels: labels, counts: counts };
}
`;

// ── Sandbox ────────────────────────────────────────────────────────────────
interface Recorded { canvas: unknown; config: any }
const recorded: Recorded[] = [];

function makeSandbox(): Record<string, any> {
  const sandbox: Record<string, any> = { console };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  // Recording stand-in for the Chart.js constructor. Chart.defaults is reached
  // from inside the legend's generateLabels callback, which the capture never
  // invokes — it is frozen as source text — but it must exist for the property
  // chain to be writable if a future change does call it.
  function Chart(this: any, canvas: unknown, config: any) {
    recorded.push({ canvas, config });
    this.config = config;
  }
  (Chart as any).defaults = { plugins: { legend: { labels: { generateLabels: () => [] } } } };
  (Chart as any).register = () => {};
  sandbox.Chart = Chart;
  sandbox.ChartBoxPlot = undefined;   // the boxplot register block is skipped
  sandbox.matchMedia = () => ({ matches: false });
  sandbox.document = { documentElement: {} };
  sandbox.getComputedStyle = () => ({
    getPropertyValue: (name: string) => THEME[name] || '',
  });
  vm.createContext(sandbox);
  return sandbox;
}

const sandbox = makeSandbox();
const source = PRELUDE + '\n' + CHART_SCRIPTS
  .map((f) => '\n// ==== ' + f + ' ====\n' + fs.readFileSync(path.join(HUB, f), 'utf8'))
  .join('\n');
// The classic-script scope is the script's own lexical scope, so top-level
// `const`s are unreachable from outside it — the capture expression is appended
// INSIDE that scope, exactly as test-plotSpec.ts does.
const api: { buildChart: Function } = vm.runInContext(
  source + '\n;({ buildChart: buildChart });', sandbox, { filename: 'chart-family.js' });

// ── Fixture ────────────────────────────────────────────────────────────────
// One dataset that reaches every family: 4 series (candlestick reads O/H/L/C,
// bubble reads x/y/r), a null and a non-numeric cell (the `typeof v === 'number'`
// guards), a zero, and a value over the 10000 raw/abbreviated label threshold.
const DATA = {
  labels: ['North', 'South', 'East', 'West', 'Central'],
  series: [
    { name: 'Q1', values: [120, 340.5, 80, 0, 15000] },
    { name: 'Q2', values: [95, 210, null, 45, 12000] },
    { name: 'Q3', values: [130, 'n/a', 60, 70, 9000] },
    { name: 'Q4', values: [110, 260, 75, 55, 11000] },
  ],
};

// A calendar heatmap draws DAYS, so it has its own fixture: a year boundary, a
// null and a gap. On DATA above (region names) it returns null — asserted below.
const CAL_DATA = {
  labels: ['2023-12-28', '2023-12-29', '2023-12-31', '2024-01-01', '2024-01-02', '2024-01-05', '2024-01-08'],
  series: [{ name: 'sum of revenue', values: [120, 340.5, null, 0, 15000, 95, 210] }],
};

// Three override sets: the defaults every chart is first drawn with, the
// Customize menu turned all the way up, and the filtered/export shape (hidden
// series, a period pick, no animation, tooltips off).
const OVERRIDES: Record<string, any> = {
  default: {},
  custom: {
    title: 'Revenue by region', color: '#ff6600', valueMode: 'all',
    showGridlines: false, xAxisLabel: 'Region', yAxisLabel: 'Revenue',
    sort: 'desc', yZero: true, numberFormat: 'currency', smooth: false,
    legendPosition: 'right', showLegend: true,
  },
  filtered: {
    hiddenSeries: [1], valueMode: 'min', showLegend: false, periodIdx: 0,
    noAnimate: true, devicePixelRatio: 2, showTooltips: false, yZero: false,
  },
};

// ── Deterministic serialisation ────────────────────────────────────────────
// Key order sorted, so an object literal reordered by the split still matches.
// Functions kept as SOURCE: a plugin's afterDatasetsDraw body, an axis tick
// callback and a scriptable gradient are the parts most likely to drift, and
// they are exactly what a shallow JSON.stringify would drop.
function ser(v: unknown, depth = 0): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const t = typeof v;
  // Function source with per-line indentation stripped. Leading whitespace is
  // never semantic in JavaScript — and moving a function OUT of buildChart into
  // a sibling module changes exactly that and nothing else, because tsc emits it
  // at a shallower depth. Everything that IS semantic (identifiers, operators,
  // string contents, which locals a closure names) still has to match. There are
  // no multi-line template literals in this layer, which is the one place a
  // leading space would carry meaning.
  // Whole-line comments go with the indentation, for the same reason: a comment
  // is not semantic either, and hashing them means every explanatory line added
  // to a plugin body fails this suite as a "config change" when nothing about
  // the config moved. Only lines that START with // after trimming are dropped,
  // so a `//` inside a string literal is untouched.
  if (t === 'function') return 'fn<' + String(v).replace(/\r\n/g, '\n')
    .split('\n').map((ln) => ln.trim()).filter((ln) => !ln.startsWith('//')).join('\n') + '>';
  if (t === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (t === 'string' || t === 'boolean' || t === 'bigint') return JSON.stringify(String(v));
  if (depth > 12) return '«deep»';
  if (Array.isArray(v)) return '[' + v.map((x) => ser(x, depth + 1)).join(',') + ']';
  if (v instanceof Set) return 'Set[' + Array.from(v).map((x) => ser(x, depth + 1)).sort().join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + ser(o[k], depth + 1)).join(',') + '}';
}

const shortHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── Capture ────────────────────────────────────────────────────────────────
// Every id in VIZ_LABELS, including `table` and the two map ids. Those three are
// never routed to buildChart by the app — renderResult dispatches them to
// buildDataTable/renderMap — so what they capture is buildChart's `default:`
// branch (a plain column chart). Included on purpose: that branch is real code
// and the split must not move it either.
const CHART_IDS = [
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar',
  'line', 'line_markers', 'area', 'stacked_area',
  'pie', 'donut', 'scatter', 'gauge', 'combo', 'bubble',
  'treemap', 'heatmap', 'funnel', 'histogram',
  'sankey', 'candlestick', 'boxplot',
  'waterfall', 'bullet', 'calendar', 'radar', 'pareto',
  'table', 'map_bubble', 'map_choropleth',
];

// Set ORDINATE_CHARTSPEC_DUMP=<dir> to write every serialisation there — the
// way to DIFF a deliberate change, rather than stare at two hashes.
const DUMP_DIR = process.env.ORDINATE_CHARTSPEC_DUMP || '';

function capture(type: string, variant: string): { text: string; ok: boolean } {
  recorded.length = 0;
  const canvas = { __canvas: type } as unknown as HTMLCanvasElement;
  // A fresh deep copy per case: buildChart writes back onto `overrides`-adjacent
  // state (opts._funnelVals and friends) and sorts `series` in place-ish, and a
  // shared fixture would let case N-1 colour case N.
  const data = JSON.parse(JSON.stringify(type === 'calendar' ? CAL_DATA : DATA));
  const overrides = JSON.parse(JSON.stringify(OVERRIDES[variant]));
  const chart = api.buildChart(canvas, data, type, overrides);
  if (!chart || recorded.length !== 1) return { text: '', ok: false };
  const text = ser(recorded[0].config);
  if (DUMP_DIR) fs.writeFileSync(path.join(DUMP_DIR, type + '.' + variant + '.txt'), text);
  return { text, ok: true };
}

// ── The frozen configs ─────────────────────────────────────────────────────
// sha256(serialisation).slice(0,16) per `<chart id>/<override set>`, taken from
// develop at 488b63e, before the split. THESE ARE NOT TO BE REGENERATED to make
// a red run green: a mismatch means buildChart now produces a different chart.
// REGENERATED once, deliberately, for the round-label fit gate (fix/donut-labels):
// pie, donut and gauge — gauge because a gauge IS a Chart.js doughnut and shares
// the `roundLabels` plugin — moved because that plugin now measures its text and
// skips a slice that cannot hold it. 9 of 84 hashes changed and the other 75 did
// not, which is the shape a change confined to one plugin should have.
// REGENERATED again, deliberately, for the round-family legend fix
// (fix/round-legend): ALL 84 moved, and that is the honest shape this time —
// `legend.labels.generateLabels` is not per-family like `roundLabels`, it sits in
// the ONE options block every chart id shares, so editing a line inside it
// necessarily re-serialises all 84. Verified confined before regenerating: with
// ORDINATE_CHARTSPEC_DUMP set on both sides, the only differing line across all
// 84 dumps is that callback's first statement. Every other movement in this
// table is a regression until proven otherwise. What the legend RENDERS is
// asserted in scripts/test-chartLegend.ts — a hash cannot tell a legend of three
// category names from a legend of one `null`.
// REGENERATED again, deliberately, for the gauge round-label fix
// (fix/gauge-labels): exactly 3 moved — gauge/default, gauge/custom,
// gauge/filtered — and pie/donut did NOT, which is the whole point. A gauge is a
// Chart.js doughnut, so it was picking up `roundLabels` and drawing the metric
// name a second time on the arc, over the caption gaugeCenter already prints.
// `roundLabels` is added per-family, so excluding gauge from it can only move
// gauge's three configs; any fourth would have been a regression.
  // REGENERATED again, deliberately, for the value-label number format
  // (fix/value-label-format): 66 of 84 moved, and the 18 that did not are the
  // six families whose plugins print no cartesian/round/matrix value label at
  // all (gauge, funnel, sankey, candlestick, boxplot, treemap).
  //
  // Verified confined BEFORE regenerating, per the rule above: with
  // ORDINATE_CHARTSPEC_DUMP set on this branch and on origin/develop, the only
  // differing lines across all 84 dumps are the three copies of the value-label
  // expression this change replaced with one valueLabelText() call — and
  // nothing else in any config moved. What that function RETURNS is asserted in
  // scripts/test-valueLabelText.ts; a hash cannot tell "3,908.36" from
  // "3908.359999999999".
const GOLDEN: Record<string, string> = {
  // Regenerated ONCE when the serialiser stopped hashing whole-line comments
  // (see ser() above), and REGENERATED AGAIN on the merge with develop, which had
  // meanwhile regenerated the same table for the round-legend and gauge fixes.
  // 79 of 84 moved — every case whose serialised functions contain a comment —
  // and the 5 that did not are the ones with no comment to strip.
  //
  // Verified attributable to the serialiser alone, not to the merge: this branch's
  // only change under renderer/hub is two explanatory comment blocks in
  // chartValueLabels.ts, and dumping all 84 serialisations with and without them
  // (ORDINATE_CHARTSPEC_DUMP on both sides) gives 84 byte-identical files. So
  // nothing about what buildChart draws moved.
  // fix/gauge-sort moved ONE case, gauge/custom: `canSort` stopped being true
  // for a gauge (it is a doughnut, so `isRound` caught it). Only `custom` sets
  // overrides.sort, so it is the only override set whose config the sort branch
  // touched at all — 1 of 84 is the shape a change gated on one override has.
  // REGENERATED again, deliberately, for the period overlay
  // (feat/analysis-depth): 57 of 84 moved — exactly the configs that carry the
  // cartesian valueLabels plugin — because that plugin now skips a dataset
  // marked `_overlay` (a prior-year comparison series is context, not a figure
  // to label). Verified confined BEFORE regenerating: with
  // ORDINATE_CHARTSPEC_DUMP set on this branch and on origin/develop, the only
  // differing lines across all 84 dumps are those two lines of that plugin.
  // REGENERATED again, deliberately, for Format → Data labels (feat/build-depth,
  // format): 66 of 99 moved — the 57 configs carrying the cartesian valueLabels
  // plugin, the 6 pie/donut roundLabels and the 3 heatmap matrixValueLabels —
  // because a label's text now comes from valueLabelOf (the label's own number
  // format, else the chart's) and the cartesian one's placement and ink from
  // valueLabelAt (outside / inside / centre). Verified confined BEFORE
  // regenerating: with ORDINATE_CHARTSPEC_DUMP on the base and this branch, the
  // only differing lines across all 99 dumps are those label expressions; and
  // with this branch's chartRender.ts (custom sort, the fmtResolve/fmtApply
  // hooks) over the base chartValueLabels.ts, all 99 hashes still matched.
  "area/custom": 'ab5a9cda93805bcd',
  "area/default": 'e8204ebef2468470',
  "area/filtered": 'b00c7658a627c735',
  "bar/custom": 'c1d565e733b381d5',
  "bar/default": 'b6f18df985ce448a',
  "bar/filtered": '18afb86e58227836',
  "boxplot/custom": 'f28cfccbae124eb9',
  "boxplot/default": 'fa5f95629263f4df',
  "boxplot/filtered": 'b169c7ac3c58dc00',
  "bubble/custom": '708936d57b2521b5',
  "bubble/default": '6c17a842955f568f',
  "bubble/filtered": 'c59be4c4983ecadc',
  "candlestick/custom": '615d31c8118d3f04',
  "candlestick/default": 'ac5d0986bdb30f99',
  "candlestick/filtered": '5cc77bfb08ce431b',
  "clustered_bar/custom": 'c1d565e733b381d5',
  "clustered_bar/default": 'b6f18df985ce448a',
  "clustered_bar/filtered": '18afb86e58227836',
  "clustered_column/custom": '4763d02e60de9b76',
  "clustered_column/default": '0dac9394d5f8e396',
  "clustered_column/filtered": '9bd5d475a617dabd',
  "column/custom": '4763d02e60de9b76',
  "column/default": '0dac9394d5f8e396',
  "column/filtered": '9bd5d475a617dabd',
  "combo/custom": '28673d9244c7c5bd',
  "combo/default": '6d6e408442aac5ff',
  "combo/filtered": '53cf363c77ef9cdd',
  "donut/custom": '02394dfd7246a579',
  "donut/default": '63ddb84f6355fc62',
  "donut/filtered": '5d3ef306a451ec54',
  "funnel/custom": 'a834f41f67417e7c',
  "funnel/default": '8dc573bb4ec3135d',
  "funnel/filtered": 'a63e174df450904d',
  "gauge/custom": 'ea4848d7536ccf28',
  "gauge/default": '82a06baedf35fee0',
  "gauge/filtered": '5bb65e740b74bdf1',
  "heatmap/custom": '40d409bd97adaae1',
  "heatmap/default": '48642e21781fe2ab',
  "heatmap/filtered": 'd3a4f5cbde813cc6',
  "histogram/custom": 'fb0df2faff31d6d1',
  "histogram/default": 'f44f51ca4845fb28',
  "histogram/filtered": '98d7982a2b7e3e6f',
  "line/custom": '9f08e8e3f43fc472',
  "line/default": '8ebabf6a3c8a6b67',
  "line/filtered": '17c5fc8f0343487d',
  "line_markers/custom": '22ddfe245cbaa218',
  "line_markers/default": '81e71bbe3969bf85',
  "line_markers/filtered": '87ebfaf324a8f53d',
  "map_bubble/custom": '4763d02e60de9b76',
  "map_bubble/default": '0dac9394d5f8e396',
  "map_bubble/filtered": '9bd5d475a617dabd',
  "map_choropleth/custom": '4763d02e60de9b76',
  "map_choropleth/default": '0dac9394d5f8e396',
  "map_choropleth/filtered": '9bd5d475a617dabd',
  "pct_stacked_bar/custom": '29bed9ae72a5efa1',
  "pct_stacked_bar/default": '9e6e22d2c39a1f72',
  "pct_stacked_bar/filtered": '678d1922a0bd58e6',
  "pct_stacked_column/custom": 'd0dbf231fa0bf988',
  "pct_stacked_column/default": '5fc2a56b2cacd184',
  "pct_stacked_column/filtered": '8f901f26c1bf134d',
  "pie/custom": '97eb295ca8967c35',
  "pie/default": '521642246d25d13b',
  "pie/filtered": '6c385a95d3b437fd',
  "sankey/custom": '48eadd37dc79c0c0',
  "sankey/default": '6db6c0e34b05e192',
  "sankey/filtered": '6bf246ad16fd94ba',
  "scatter/custom": '210bd7a3c4835986',
  "scatter/default": '665dc790bc1f6877',
  "scatter/filtered": 'cdd29412a7560aba',
  "stacked_area/custom": 'd2cf6108099743d2',
  "stacked_area/default": '2ccf968291445a4b',
  "stacked_area/filtered": '5801838ed91596a3',
  "stacked_bar/custom": '931f82521872e436',
  "stacked_bar/default": '2604c4476a8185b7',
  "stacked_bar/filtered": '2c24d8ed78fb95e0',
  "stacked_column/custom": '57533400c9a16a71',
  "stacked_column/default": 'c04a4c5fca9ee0e5',
  "stacked_column/filtered": '063198e78706c64d',
  "table/custom": '4763d02e60de9b76',
  "table/default": '0dac9394d5f8e396',
  "table/filtered": '9bd5d475a617dabd',
  "treemap/custom": 'dd923b5b900019ca',
  "treemap/default": '6ca42388e2a2b681',
  "treemap/filtered": 'd8a949baca22c73f',
  // ADDED, not regenerated (feat: five chart types): the waterfall, bullet,
  // calendar, radar and Pareto ids are new, drawn by chartFamiliesExtra.js /
  // chartFamiliesPlugins.js, which the three family builders hand them to
  // BEFORE any shared closure is reached — so every one of the 84 hashes above
  // is untouched, and these 15 are first captures. The calendar's come from
  // CAL_DATA (dates); the rest from DATA like every other id.
  "bullet/custom": '5bc0d248a9b8bfbc',
  "bullet/default": '6c97f54c2959e833',
  "bullet/filtered": 'a79539bcc34b3448',
  "calendar/custom": 'e1e20f632b792594',
  "calendar/default": '4b58d99a353f6cc3',
  "calendar/filtered": '96fda73d4a6035a6',
  "pareto/custom": 'e7d631f415e13fdd',
  "pareto/default": '038ee57d8e57c353',
  "pareto/filtered": 'bd4d81e4abf3250b',
  "radar/custom": 'dc40adaf793208de',
  "radar/default": '35556f15a6c3aeb3',
  "radar/filtered": 'f84411f7fa2454ec',
  "waterfall/custom": '7452a0fa8073365a',
  "waterfall/default": '8a6d36f1e5655b37',
  "waterfall/filtered": 'ebb1008f0152b931',
};

// ── Run ────────────────────────────────────────────────────────────────────
const variants = Object.keys(OVERRIDES);
const fresh: Record<string, string> = {};
let captured = 0;

for (const type of CHART_IDS) {
  for (const variant of variants) {
    const key = type + '/' + variant;
    const got = capture(type, variant);
    if (!got.ok) {
      ok('captured ' + key, false, 'buildChart returned null / recorded ' + recorded.length + ' configs');
      continue;
    }
    captured++;
    const h = shortHash(got.text);
    fresh[key] = h;
    const want = GOLDEN[key];
    if (want === undefined) {
      ok('golden covers ' + key, false, 'no frozen hash for this case');
      continue;
    }
    if (h !== want) {
      const dump = path.join(os.tmpdir(), 'chartSpec-' + key.replace('/', '-') + '.txt');
      try { fs.writeFileSync(dump, got.text); } catch { /* a dump is a courtesy */ }
      ok('config unchanged: ' + key, false, 'want ' + want + ' got ' + h + ' — serialisation written to ' + dump);
    } else {
      ok('config unchanged: ' + key, true);
    }
  }
}

ok('every chart id x override set captured a config',
   captured === CHART_IDS.length * variants.length,
   captured + ' of ' + CHART_IDS.length * variants.length);
ok('33 chart ids covered', CHART_IDS.length === 33, String(CHART_IDS.length));
ok('the golden table has no stale entries',
   Object.keys(GOLDEN).every((k) => k in fresh),
   Object.keys(GOLDEN).filter((k) => !(k in fresh)).join(', '));

// A hash table of 84 identical values would pass every comparison above while
// proving nothing, so assert the captures actually differ from one another.
ok('captured configs are distinct per chart id',
   new Set(Object.values(fresh)).size >= CHART_IDS.length,
   new Set(Object.values(fresh)).size + ' distinct of ' + Object.keys(fresh).length);

// ── Which inline plugins a family carries ──────────────────────────────────
// A hash says a config CHANGED, never what it now contains — so name the one
// thing this file's last regeneration was about. A gauge is drawn as a Chart.js
// doughnut, so it used to pick up `roundLabels` and write the metric name onto
// the arc, on top of the caption `gaugeCenter` already prints under the big
// number: the same words twice on one small chart. Asserted in both directions,
// because "no roundLabels" is also what a gauge that stopped building any
// plugins at all would look like.
function pluginIds(type: string): string[] {
  recorded.length = 0;
  api.buildChart({ __canvas: type } as unknown as HTMLCanvasElement,
                 JSON.parse(JSON.stringify(DATA)), type, {});
  return ((recorded[0] && recorded[0].config.plugins) || []).map((p: any) => p.id);
}
const gaugeIds = pluginIds('gauge');
ok('a gauge carries no roundLabels plugin', !gaugeIds.includes('roundLabels'), gaugeIds.join(', '));
ok('a gauge still prints its own centre caption', gaugeIds.includes('gaugeCenter'), gaugeIds.join(', '));
for (const t of ['pie', 'donut']) {
  const ids = pluginIds(t);
  ok(t + ' still labels its slices', ids.includes('roundLabels'), ids.join(', '));
  ok(t + ' has no gauge centre plugin', !ids.includes('gaugeCenter'), ids.join(', '));
}

// ── The five newer families ────────────────────────────────────────────────
// Each carries its own plugins and none of the shared value-label ones, and a
// calendar over labels that are not dates draws NOTHING rather than a blank grid.
const want: Record<string, string[]> = {
  waterfall: ['waterfallConnectors', 'waterfallLabels'],
  pareto: ['paretoMarker', 'paretoLabels'],
  bullet: ['bulletBands'],
  radar: [],
};
for (const [t, ids] of Object.entries(want)) {
  const got = pluginIds(t);
  ok(t + ' carries exactly its own plugins', got.join() === ids.join(), got.join(', '));
}
recorded.length = 0;
ok('a calendar over non-date labels is not drawn at all',
   api.buildChart({ __canvas: 'calendar' } as unknown as HTMLCanvasElement,
                  JSON.parse(JSON.stringify(DATA)), 'calendar', {}) === null && recorded.length === 0);

if (process.env.ORDINATE_CHARTSPEC_EMIT) {
  // Regeneration aid for the ONE case this is legitimate: a deliberate,
  // reviewed change to what buildChart draws. Prints the GOLDEN literal.
  console.log(Object.keys(fresh).sort()
    .map((k) => `  ${JSON.stringify(k)}: '${fresh[k]}',`).join('\n'));
}

finish();
if (failureCount()) process.exit(1);
