// Self-check for the legend buildChart actually renders — the TEXTS, not the count.
//
// WHY IT EXISTS, next to test-chartSpec.ts. That suite freezes the config as a
// hash, with every callback kept as SOURCE TEXT. A hash proves the callback did
// not change; it cannot prove the callback is right. The round-family legend bug
// is exactly what slips through: `generateLabels` called
// `Chart.defaults.plugins.legend.labels.generateLabels`, the DATASET-based
// generator, for every chart type. Pie and doughnut do not use that one — Chart.js
// puts a per-SLICE generator on `Chart.overrides.doughnut` (pie inherits it as a
// static class property) — so a 3-category donut produced ONE item whose text was
// the dataset's absent label: `[null]`. The config hash was stable throughout.
//
// That matters beyond looks. chartValueLabels drops a slice's label when the text
// cannot fit the slice, on the standing promise that the legend still names it;
// legendOnByDefault() in chartTraits.ts returns true for pie and donut precisely
// so that fallback exists. A legend of one blank entry is not a fallback.
//
// SO THIS ASSERTS THE TEXTS. One `null` and one string are both "length 1", which
// is how the bug hid — a count assertion would have passed on the broken build.
//
// HOW. Same shape as test-chartSpec.ts: the emitted renderer siblings run in a
// `vm` sandbox (classic global-scope scripts, nothing to import), buildChart
// builds the real config, and the legend callback is pulled off it and INVOKED.
// The difference is the Chart stub: the REAL chart.umd.js is evaluated in the
// sandbox first, so `Chart.defaults` and `Chart.overrides` are Chart.js's own —
// a hand-written `overrides` table would only test that the code reads the
// property this test says it reads, not that Chart.js puts the generator there.
// Only the constructor is swapped for a recorder, since there is no canvas.
//
//   npm run build:ts && node scripts/test-chartLegend.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const HUB = path.join(__dirname, '..', 'renderer', 'hub');
const CHART_UMD = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');

// index.html's dependency order, as in test-chartSpec.ts.
const CHART_SCRIPTS = [
  'chartTraits.js', 'chartPalette.js', 'chartTypeSpec.js', 'chartShapes.js', 'chartFamiliesExtra.js', 'chartFamiliesPlugins.js',
  'chartValueLabels.js', 'chartDatasets.js', 'chartScales.js', 'chartRender.js',
];

const THEME: Record<string, string> = {
  '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6',
  '--chart-4': '#6366f1', '--chart-5': '#64748b',
  '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff',
  '--text-strong': '#111827', '--font-ui': 'Inter, system-ui, sans-serif',
  '--accent': '#2563eb', '--ok': '#16a34a', '--error': '#dc2626',
};

// The formatters buildChart resolves off hub.js's global scope. Stubs, not
// copies: this suite asserts legend TEXT, and no legend text is a formatted
// number — chartSpec is where the formatters are pinned.
const PRELUDE = `
function _fmtVal(v) { return v == null ? '' : String(v); }
function fmtWith(v) { return v == null ? '' : String(v); }
function histogramBins(values) { return { labels: values.map(String), counts: values.map(function(){return 1;}) }; }
`;

// ── Sandbox ────────────────────────────────────────────────────────────────
interface Recorded { config: any }
const recorded: Recorded[] = [];

const sandbox: Record<string, any> = { console };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.matchMedia = () => ({ matches: false });
sandbox.document = { documentElement: {}, createElement: () => ({ style: {}, getContext: () => null }) };
sandbox.requestAnimationFrame = (f: Function) => f;
sandbox.cancelAnimationFrame = () => {};
sandbox.getComputedStyle = () => ({ getPropertyValue: (n: string) => THEME[n] || '' });
vm.createContext(sandbox);

// Real Chart.js — this is what makes `Chart.overrides.doughnut` real.
vm.runInContext(fs.readFileSync(CHART_UMD, 'utf8'), sandbox, { filename: 'chart.umd.js' });
const RealChart = sandbox.Chart;
ok('real Chart.js loaded in the sandbox', typeof RealChart === 'function');
ok('Chart.overrides.doughnut carries a per-slice generateLabels',
   typeof RealChart.overrides?.doughnut?.plugins?.legend?.labels?.generateLabels === 'function');
ok('Chart.overrides.pie carries a per-slice generateLabels',
   typeof RealChart.overrides?.pie?.plugins?.legend?.labels?.generateLabels === 'function');
ok('Chart.overrides.bar carries NO generateLabels (the default is right for it)',
   RealChart.overrides?.bar?.plugins?.legend?.labels?.generateLabels === undefined);

// Recording stand-in with Chart.js's real statics: there is no canvas here, so
// `new Chart()` must not build one, but everything buildChart reads off the
// constructor has to be genuine.
function Rec(this: any, _canvas: unknown, config: any) {
  recorded.push({ config });
  this.config = config;
}
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

// ── Fixture ────────────────────────────────────────────────────────────────
// Three categories and two named series: a round chart's legend must list the
// CATEGORIES, a bar/line legend must list the SERIES, from the same data.
const CATEGORIES = ['North', 'South', 'East'];
const SERIES_NAMES = ['Q1', 'Q2'];
const DATA = {
  labels: CATEGORIES.slice(),
  series: [
    { name: 'Q1', values: [120, 340, 80] },
    { name: 'Q2', values: [95, 210, 60] },
  ],
};

// ── A chart object the generators can read ─────────────────────────────────
// Chart.js's two generators between them touch data, legend.options, the
// per-index style off a dataset meta, and the visibility predicates. None of it
// needs a canvas, so it is stubbed from the config buildChart just produced.
function fakeChart(config: any): any {
  const datasets = config.data.datasets;
  const styleFor = (dsIdx: number, i: number) => {
    const ds = datasets[dsIdx] || {};
    const pick = (v: any) => (Array.isArray(v) ? v[i % v.length] : v);
    return {
      backgroundColor: pick(ds.backgroundColor),
      borderColor: pick(ds.borderColor),
      borderWidth: typeof ds.borderWidth === 'number' ? ds.borderWidth : 1,
    };
  };
  const chart: any = {
    config: { type: config.type },
    data: config.data,
    options: { color: THEME['--text-strong'] },
    legend: { options: config.options.plugins.legend },
    getDatasetMeta: (i: number) => ({
      index: i,
      visible: !(datasets[i] || {}).hidden,
      controller: { getStyle: (idx: number) => styleFor(i, idx || 0) },
    }),
    getDataVisibility: () => true,
    isDatasetVisible: (i: number) => !(datasets[i] || {}).hidden,
  };
  chart._getSortedDatasetMetas = () => datasets.map((_: unknown, i: number) => chart.getDatasetMeta(i));
  return chart;
}

function legendItems(vizType: string): any[] {
  recorded.length = 0;
  const data = JSON.parse(JSON.stringify(DATA));
  const chart = api.buildChart({ __canvas: vizType } as any, data, vizType, {});
  if (!chart || recorded.length !== 1) throw new Error('buildChart recorded ' + recorded.length + ' configs for ' + vizType);
  const config = recorded[0].config;
  const legend = config.options.plugins.legend;
  if (!legend || legend.display !== true) throw new Error(vizType + ' legend is not displayed');
  return legend.labels.generateLabels(fakeChart(config));
}

const texts = (items: any[]) => items.map((it) => it.text);
const same = (a: unknown[], b: unknown[]) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// ── The round family lists its CATEGORIES ──────────────────────────────────
for (const id of ['pie', 'donut']) {
  let items: any[] = [];
  let err = '';
  try { items = legendItems(id); } catch (e) { err = String(e); }
  ok(id + ' legend built', !err, err);
  ok(id + ' legend lists every category once',
     same(texts(items), CATEGORIES),
     JSON.stringify(texts(items)) + ' want ' + JSON.stringify(CATEGORIES));
  ok(id + ' legend has no blank entry',
     items.length > 0 && items.every((it) => typeof it.text === 'string' && it.text !== ''),
     JSON.stringify(texts(items)));
  ok(id + ' legend gives each slice its own swatch colour',
     new Set(items.map((it) => it.fillStyle)).size === CATEGORIES.length,
     JSON.stringify(items.map((it) => it.fillStyle)));
}

// ── The bar/line families list their SERIES, and keep the solid swatch ─────
for (const id of ['bar', 'column', 'line', 'area']) {
  let items: any[] = [];
  let err = '';
  try { items = legendItems(id); } catch (e) { err = String(e); }
  ok(id + ' legend built', !err, err);
  ok(id + ' legend lists every series once',
     same(texts(items), SERIES_NAMES),
     JSON.stringify(texts(items)) + ' want ' + JSON.stringify(SERIES_NAMES));
}

// The reason the override exists at all: a line/area swatch defaults to a hollow
// box (transparent fill), so it is repainted with the line colour. Sourcing the
// generator per type must not lose that.
for (const id of ['line', 'area']) {
  const items = legendItems(id);
  ok(id + ' swatches are painted solid with the line colour',
     items.length > 0 && items.every((it) => it.fillStyle === it.strokeStyle && it.lineWidth === 0),
     JSON.stringify(items.map((it) => [it.fillStyle, it.strokeStyle, it.lineWidth])));
}

finish();
