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
  'chartAnnotations.js',
  'chartDatasets.js',
  'chartScales.js',
  'chartRender.js', 'calcMenu.js',
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
  //
  // REGENERATED again, deliberately, for dashboard motion (r7:motion): 99 moved
  // — every Chart.js config — because the ONE animation config is now 300 ms
  // easeOutCubic (was 480 ms easeOutQuart) and carries a `transitions.mtStep`
  // half-step. Verified confined BEFORE regenerating: putting the old animation
  // object back and dropping `transitions` from each fresh dump reproduces all
  // 99 old hashes exactly, so nothing else in any config moved.
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
  "area/custom": '4074680a7a006c2d',
  "area/default": '7b844f667372ed65',
  "area/filtered": 'b27ef443b319bc84',
  "bar/custom": '310d4b5103164ae8',
  "bar/default": '89615d00638660e3',
  "bar/filtered": 'cc977ca910ab6c13',
  "boxplot/custom": '255c714644677f40',
  "boxplot/default": '95e326997d478187',
  "boxplot/filtered": 'ee8854e7cd905c59',
  "bubble/custom": '6170f1ece836b1bc',
  "bubble/default": '81bced0d33fb107f',
  "bubble/filtered": 'ff72918c1012989c',
  "candlestick/custom": '78cba871077f593d',
  "candlestick/default": '57db9adf5abc7289',
  "candlestick/filtered": 'abe85a080ea40d3d',
  "clustered_bar/custom": '310d4b5103164ae8',
  "clustered_bar/default": '89615d00638660e3',
  "clustered_bar/filtered": 'cc977ca910ab6c13',
  "clustered_column/custom": '7b800836ba03b81d',
  "clustered_column/default": '0171b536e9525864',
  "clustered_column/filtered": '1de6877b48ab77d4',
  "column/custom": '7b800836ba03b81d',
  "column/default": '0171b536e9525864',
  "column/filtered": '1de6877b48ab77d4',
  "combo/custom": '049f0038357bb6c6',
  "combo/default": '010b97db38584eec',
  "combo/filtered": 'a323d3ef615bcc8a',
  "donut/custom": '9f0e1b039855bc92',
  "donut/default": '976a74d6ccf5e736',
  "donut/filtered": '14f854a6100f880d',
  "funnel/custom": 'bd3b24a2f81147a0',
  "funnel/default": '4012c25b88a631d0',
  "funnel/filtered": '183a66ccd73aab4f',
  "gauge/custom": 'd8343b25ff7bb6b3',
  "gauge/default": 'e5a77accd5c80410',
  "gauge/filtered": 'ae3e9c42430ed11c',
  "heatmap/custom": '91e2c02064f2e4a8',
  "heatmap/default": 'e9ea8adca325646b',
  "heatmap/filtered": 'f67b5eca68a79c6f',
  "histogram/custom": '19c31baaee94b02a',
  "histogram/default": '31e3f580dbc9dc46',
  "histogram/filtered": 'dfe1d71b6d7a1443',
  "line/custom": '7edd0bff0ade7a53',
  "line/default": '8dc1bbe1fc0ae5d7',
  "line/filtered": '0dd48c551115e937',
  "line_markers/custom": '871ca0c33360eb66',
  "line_markers/default": '9d5404932fc4664e',
  "line_markers/filtered": '1b545778d4ad0232',
  "map_bubble/custom": '7b800836ba03b81d',
  "map_bubble/default": '0171b536e9525864',
  "map_bubble/filtered": '1de6877b48ab77d4',
  "map_choropleth/custom": '7b800836ba03b81d',
  "map_choropleth/default": '0171b536e9525864',
  "map_choropleth/filtered": '1de6877b48ab77d4',
  "pct_stacked_bar/custom": '030d824125883672',
  "pct_stacked_bar/default": '7f71917e76383878',
  "pct_stacked_bar/filtered": '9256424c521b0ee3',
  "pct_stacked_column/custom": '1c7545befe598fa2',
  "pct_stacked_column/default": '6b1c1534558d0aa2',
  "pct_stacked_column/filtered": 'b7b5aa3cd39ce2ca',
  "pie/custom": 'd2d2ec95283808fe',
  "pie/default": '54d1f52036bcd846',
  "pie/filtered": 'ffae50ec4585864c',
  "sankey/custom": '8ef26df701f5a478',
  "sankey/default": '750316c6643f764b',
  "sankey/filtered": 'eacb3ce273ad38a8',
  "scatter/custom": 'b8f80210123579eb',
  "scatter/default": '5280040df1b5da6b',
  "scatter/filtered": 'ddac78b88daadfb1',
  "stacked_area/custom": '4113eef145a2c46e',
  "stacked_area/default": 'f0dacf3ee8d161d7',
  "stacked_area/filtered": '8ece80995a778dd9',
  "stacked_bar/custom": 'e3fddd2b5872214f',
  "stacked_bar/default": '56b71b1877cbb914',
  "stacked_bar/filtered": 'f96b38670707c291',
  "stacked_column/custom": '3375c5496fa56c1f',
  "stacked_column/default": '4a3ee4bcf4820fe3',
  "stacked_column/filtered": '544e231f6eba59d1',
  "table/custom": '7b800836ba03b81d',
  "table/default": '0171b536e9525864',
  "table/filtered": '1de6877b48ab77d4',
  "treemap/custom": '0a05a593da1a44b4',
  "treemap/default": '65e2534ea7f818f5',
  "treemap/filtered": 'b14d7e9e4fa33c7a',
  // ADDED, not regenerated (feat: five chart types): the waterfall, bullet,
  // calendar, radar and Pareto ids are new, drawn by chartFamiliesExtra.js /
  // chartFamiliesPlugins.js, which the three family builders hand them to
  // BEFORE any shared closure is reached — so every one of the 84 hashes above
  // is untouched, and these 15 are first captures. The calendar's come from
  // CAL_DATA (dates); the rest from DATA like every other id.
  "bullet/custom": '8ad31fb78a82c88b',
  "bullet/default": 'ea39af6fae5daaaf',
  "bullet/filtered": '5e88b7ff8f3d4344',
  "calendar/custom": 'dc66bcca11a4f347',
  "calendar/default": 'aae90b7f45586da2',
  "calendar/filtered": 'd89036dbbbce771d',
  "pareto/custom": '733254262435cf18',
  "pareto/default": '35cd4cd91a6b20e5',
  "pareto/filtered": '7682619f4f68a932',
  "radar/custom": '41ecb578be5c6ef6',
  "radar/default": '9d9d9d13a00c4eb3',
  "radar/filtered": 'fa73a9c0962dff5c',
  "waterfall/custom": '0d6188181b9b0a98',
  "waterfall/default": '945365a490ac4f5b',
  "waterfall/filtered": 'de1de4d507198849',
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
