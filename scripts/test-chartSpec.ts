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
  if (t === 'function') return 'fn<' + String(v).replace(/\r\n/g, '\n')
    .split('\n').map((ln) => ln.trim()).join('\n') + '>';
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
  const data = JSON.parse(JSON.stringify(DATA));
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
const GOLDEN: Record<string, string> = {
  "area/custom": '90ba1827b59bbc7f',
  "area/default": '6db93a96ded80287',
  "area/filtered": '777b7e5633dcc158',
  "bar/custom": '0eacc684fdc12aab',
  "bar/default": 'd09042b58984410c',
  "bar/filtered": 'f240454ed12d7d01',
  "boxplot/custom": '2bfd0002fd0143a2',
  "boxplot/default": 'cadc583bcfad4eb3',
  "boxplot/filtered": 'b169c7ac3c58dc00',
  "bubble/custom": '43c2b35c2d987c3e',
  "bubble/default": 'da91f16fccefd9c4',
  "bubble/filtered": '2d541cf70e4d6ecf',
  "candlestick/custom": '59497874558d435a',
  "candlestick/default": 'aea006d6135e514c',
  "candlestick/filtered": '5cc77bfb08ce431b',
  "clustered_bar/custom": '0eacc684fdc12aab',
  "clustered_bar/default": 'd09042b58984410c',
  "clustered_bar/filtered": 'f240454ed12d7d01',
  "clustered_column/custom": '69267bbcf5481da5',
  "clustered_column/default": 'a973f41706828d02',
  "clustered_column/filtered": '398e271ecf36b823',
  "column/custom": '69267bbcf5481da5',
  "column/default": 'a973f41706828d02',
  "column/filtered": '398e271ecf36b823',
  "combo/custom": '86ce0df19ffba61c',
  "combo/default": 'd7a50f55f5425a99',
  "combo/filtered": 'de7629a4b4d134ff',
  "donut/custom": '2cd03b29f0a0feb2',
  "donut/default": '30bef38a690e9935',
  "donut/filtered": 'd57922dac0d08cec',
  "funnel/custom": '85636d7870e87cf8',
  "funnel/default": '79fd54ebc0ecd510',
  "funnel/filtered": 'a63e174df450904d',
  "gauge/custom": '3ee58d657b34e497',
  "gauge/default": 'f0cb1605e5cf7b0f',
  "gauge/filtered": '428f0f337ad3db37',
  "heatmap/custom": '9122e9b0ff696dcb',
  "heatmap/default": 'd6b972e27fcd03ff',
  "heatmap/filtered": 'be203644e6495e9a',
  "histogram/custom": '20a7b27edfa91347',
  "histogram/default": 'afc7b3251c7f04f2',
  "histogram/filtered": 'e1ae35d20c40d483',
  "line/custom": '76a38ccb4f9a266e',
  "line/default": '168835d1b3b7cc94',
  "line/filtered": '07e4b3cbbddd84de',
  "line_markers/custom": '371fc1b9977a2063',
  "line_markers/default": 'cbe207627912e052',
  "line_markers/filtered": '06d7c5e2b352af61',
  "map_bubble/custom": '69267bbcf5481da5',
  "map_bubble/default": 'a973f41706828d02',
  "map_bubble/filtered": '398e271ecf36b823',
  "map_choropleth/custom": '69267bbcf5481da5',
  "map_choropleth/default": 'a973f41706828d02',
  "map_choropleth/filtered": '398e271ecf36b823',
  "pct_stacked_bar/custom": '32ad92a67fca15b7',
  "pct_stacked_bar/default": 'e629a2f3f94dc08e',
  "pct_stacked_bar/filtered": '55c2076eead1bb77',
  "pct_stacked_column/custom": '46c5d38e118d1902',
  "pct_stacked_column/default": 'b4a57547a73c22b7',
  "pct_stacked_column/filtered": '6f45a6276c13bd14',
  "pie/custom": 'ba2332086e179475',
  "pie/default": '7612ec18d08a821c',
  "pie/filtered": '029a84f7f63135e5',
  "sankey/custom": 'd0843caeef6e6875',
  "sankey/default": '51142e446a8955c4',
  "sankey/filtered": '6bf246ad16fd94ba',
  "scatter/custom": '22e7b7557271eeb8',
  "scatter/default": '7f521ba2658167e8',
  "scatter/filtered": '1d2245867332b2ba',
  "stacked_area/custom": 'eda29f732bfa4120',
  "stacked_area/default": '259ca9a39ef52e15',
  "stacked_area/filtered": 'd253f04eb53979f0',
  "stacked_bar/custom": '5b1caef8442149ad',
  "stacked_bar/default": 'fb877486d71eda7b',
  "stacked_bar/filtered": '135678c87414ffe4',
  "stacked_column/custom": '9872c67d04523ddf',
  "stacked_column/default": '3941ff1032b4f0bc',
  "stacked_column/filtered": 'f3c83eec0ce5bf28',
  "table/custom": '69267bbcf5481da5',
  "table/default": 'a973f41706828d02',
  "table/filtered": '398e271ecf36b823',
  "treemap/custom": '3366955149b4b795',
  "treemap/default": 'f63f9eefe308b26f',
  "treemap/filtered": 'd8a949baca22c73f',
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
ok('28 chart ids covered', CHART_IDS.length === 28, String(CHART_IDS.length));
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

if (process.env.ORDINATE_CHARTSPEC_EMIT) {
  // Regeneration aid for the ONE case this is legitimate: a deliberate,
  // reviewed change to what buildChart draws. Prints the GOLDEN literal.
  console.log(Object.keys(fresh).sort()
    .map((k) => `  ${JSON.stringify(k)}: '${fresh[k]}',`).join('\n'));
}

finish();
if (failureCount()) process.exit(1);
