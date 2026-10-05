// ONE-OFF RECORDER (T8.1) for legacy.test.ts: the desktop's chart builders
// (chart*.js, as the root build:ts emitted them) over that test's inputs — the
// sample dataset through the server's parseFile + buildVizData, the three
// override sets, the overlays/pins/events, the data table, the word cloud
// layout and VIZ_LABELS — normalised the test's way and written, inputs
// included, to __golden__/legacy.json. Runs only with GOLDEN_RECORD=1; deleted
// with the desktop tree in the next commit.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encode } from '../../../src/server/wire.ts';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { SAMPLE_ENCODINGS } from './sampleEncodings';
import type { ChartDataShape, Cx } from './types';
import { VIZ_IDS } from './vizLabels';
import { wordCloudLayout } from './wordCloudLayout';

// Vitest runs from web/ (its config root); the repo is its parent.
const ROOT = path.resolve(process.cwd(), '..');
const HUB = path.join(ROOT, 'renderer', 'hub');
const require = createRequire(path.join(ROOT, 'package.json'));

// Light-theme tokens — the same on every run and both sides.
const THEME: Record<string, string> = {
  '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6', '--chart-4': '#6366f1',
  '--chart-5': '#64748b', '--chart-6': '#b45309', '--chart-7': '#be185d', '--chart-8': '#4d7c0f',
  '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff', '--text-strong': '#0f1117',
  '--font-ui': 'Inter, system-ui, sans-serif', '--accent': '#2563eb', '--ok': '#059669', '--error': '#e11d48',
};
const computedStyle = () => ({ getPropertyValue: (name: string) => THEME[name] || '' });

// The canvas both sides draw "into": a calendar sizes its bands off the parent.
const canvasStub = () => ({ parentElement: { clientWidth: 640, clientHeight: 320 } }) as unknown as HTMLCanvasElement;

// The three override sets of scripts/test-chartSpec.ts: first draw, Customize
// turned all the way up, and the filtered / export shape.
const OVERRIDES: Record<string, Record<string, unknown>> = {
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

// ── The legacy side ──────────────────────────────────────────────────────────

const CHART_SCRIPTS = [
  'chartTraits.js', 'chartPalette.js', 'chartTypeSpec.js', 'chartShapes.js',
  'chartFamiliesExtra.js', 'chartFamiliesPlugins.js', 'chartValueLabels.js',
  'chartAnnotations.js', 'chartEvents.js', 'chartDatasets.js', 'chartScales.js',
  'chartRender.js', 'calcMenu.js', 'chartTable.js',
];

/** A slice of an emitted legacy file between two markers, or a loud failure. */
function slice(file: string, from: string, to: string): string {
  const src = readFileSync(path.join(HUB, file), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`${file}: markers not found — has it changed shape?`);
  return src.slice(a, b);
}

interface Legacy {
  buildChart(canvas: unknown, data: unknown, type: string, overrides: unknown): unknown;
  buildDataTable(table: unknown, data: unknown): void;
  VIZ_LABELS: Record<string, string>;
  recorded: Cx[];
  wordClouds: Cx[];
}

function loadLegacy(): Legacy {
  const recorded: Cx[] = [];
  const wordClouds: Cx[] = [];
  function Chart(this: Cx, _canvas: unknown, config: unknown) {
    recorded.push(config);
    this.config = config;
  }
  const sandbox: Record<string, unknown> = {
    console,
    Chart: Object.assign(Chart, { register: () => {}, defaults: {} }),
    OrdFormat: require(path.join(ROOT, 'src/app/format.js')),
    t: (require(path.join(ROOT, 'scripts/i18nNode.js')) as { englishT: unknown }).englishT,
    matchMedia: () => ({ matches: false }),
    getComputedStyle: computedStyle,
    document: { documentElement: {}, createElement: el },
    // wordCloudRender.js draws on a real canvas; record what buildChart hands it instead.
    buildWordCloud: (_c: unknown, labels: unknown, series: unknown, overrides: unknown, theme: unknown) => {
      wordClouds.push({ labels, series, overrides, theme });
      return { wordCloud: true };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  // hub.js's formatters, taken from hub.js itself (it cannot load whole: it is the app).
  const hubFormatters = slice('hub.js', 'function _fmtVal(', '// ── Readiness banner');
  const vizLabels = slice('renderResult.js', 'const VIZ_LABELS = {', '\n// Small monochrome glyph');
  const source = [hubFormatters, ...CHART_SCRIPTS.map((f) => readFileSync(path.join(HUB, f), 'utf8')), vizLabels].join('\n;\n');
  const api = vm.runInContext(`${source}\n;({ buildChart, buildDataTable, VIZ_LABELS });`, sandbox, { filename: 'legacy-charts.js' }) as Legacy;
  return Object.assign(api, { recorded, wordClouds });
}

/** Just enough DOM for chartTable.js: elements with children, text and a style. */
function el(tag: string): Cx {
  return {
    tag, children: [] as Cx[], style: {}, textContent: '', className: '',
    appendChild(c: Cx) { this.children.push(c); return c; },
    append(...xs: Cx[]) { for (const x of xs) this.children.push(typeof x === 'string' ? { tag: '#text', textContent: x } : x); },
    set innerHTML(_v: string) { this.children = []; },
  };
}

// ── Normalising ──────────────────────────────────────────────────────────────

/** Desktop globals that are module exports here under a name without the global-scope underscore. */
const RENAMED: Record<string, string> = { _fmtVal: 'fmtVal' };

/** Plain data in THIS realm: functions → {fn: name}, keys in order, Sets as sorted lists. */
function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('too deep — a cycle?');
  if (typeof v === 'function') {
    const name = (v as { name: string }).name;
    return { fn: RENAMED[name] ?? name };
  }
  if (v === null || typeof v !== 'object') return v;
  // Array.from, not .map: a vm-realm array's .map builds another vm-realm array.
  if (Array.isArray(v)) return Array.from(v, (x) => norm(x, depth + 1));
  if (Object.prototype.toString.call(v) === '[object Set]') return { set: Array.from(v as Set<unknown>, (x) => norm(x, depth + 1)) };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = norm((v as Record<string, unknown>)[k], depth + 1);
  return out;
}

// ── The data: what the server answers for each id ────────────────────────────

const DATA = new Map<string, ChartDataShape>();
const CATEGORY = new Map<string, unknown>();
let legacy: Legacy;
let decorate: (id: string) => ChartDataShape;

beforeAll(async () => {
  if (!process.env.GOLDEN_RECORD) return;
  const { parseFile } = require(path.join(ROOT, 'src/data/fileImport.js'));
  const { buildVizData } = require(path.join(ROOT, 'src/analysis/vizData.js'));
  const { sanitizeEncoding } = require(path.join(ROOT, 'src/analysis/visuals.js'));
  const parsed = await parseFile(path.join(ROOT, 'assets/samples/retail-orders.csv'), 'csv');
  for (const id of VIZ_IDS) {
    const r = buildVizData(parsed.columns, parsed.rows, sanitizeEncoding(SAMPLE_ENCODINGS[id]), []);
    DATA.set(id, r.data);
    CATEGORY.set(id, r.category);
  }
  // The Analytics pane's overlays and the project's events, resolved by the
  // server's own pure functions — what `visual:data` attaches as
  // data.analytics / data.events.
  const { sanitizeOverlays, resolveOverlays } = require(path.join(ROOT, 'src/analysis/analytics.js'));
  const { sanitizeEvent, eventsOnAxis } = require(path.join(ROOT, 'src/analysis/events.js'));
  decorate = (id) => {
    const data = copy(DATA.get(id)!);
    const labels = data.labels ?? [];
    const overlays = sanitizeOverlays([
      { id: 'r1', kind: 'reference' },
      { id: 't1', kind: 'target', value: { type: 'constant', value: 250000 } },
      { id: 'b1', kind: 'band', sd: 1 },
      { id: 'tr', kind: 'trend' },
      { id: 'ma', kind: 'moving_average', window: 3 },
      { id: 'fc', kind: 'forecast', horizon: 3 },
      { id: 'an', kind: 'annotation', at: String(labels[3]), text: 'Price change' },
      { id: 'hl', kind: 'highlight', rule: 'top', n: 2 },
    ]);
    data.analytics = resolveOverlays(data, overlays, { category: CATEGORY.get(id) });
    const events = [
      { id: '0b6f3b9e-2c1a-4f7e-9a51-3d2c1b0a9e8f', date: '2023-03-15', title: 'Spring sale', kind: 'campaign' },
      { id: '7d1e2f3a-4b5c-4d6e-8f70-9a1b2c3d4e5f', date: '2023-11-24', end: '2023-12-31', title: 'Holidays', kind: 'holiday' },
    ].map(sanitizeEvent);
    data.events = eventsOnAxis(events, labels, 'month');
    return data;
  };
  legacy = loadLegacy();
  vi.stubGlobal('getComputedStyle', computedStyle);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

const copy = <T,>(v: T): T => structuredClone(v);


describe.runIf(process.env.GOLDEN_RECORD)('record the desktop chart engine', () => {
  it('writes __golden__/legacy.json', () => {
    const data: Record<string, unknown> = {};
    for (const id of VIZ_IDS) data[id] = copy(DATA.get(id)!);
    const configs: Record<string, unknown> = {};
    for (const variant of Object.keys(OVERRIDES)) {
      for (const id of VIZ_IDS) {
        legacy.recorded.length = 0;
        legacy.wordClouds.length = 0;
        const old = legacy.buildChart(canvasStub(), copy(DATA.get(id)!), id, copy(OVERRIDES[variant]));
        if (old === null) configs[`${id} / ${variant}`] = null;
        else if (legacy.wordClouds.length) configs[`${id} / ${variant}`] = { wordCloud: norm(legacy.wordClouds[0]) };
        else configs[`${id} / ${variant}`] = { config: norm(legacy.recorded[0]), count: legacy.recorded.length };
      }
    }
    const decorated: Record<string, unknown> = {};
    const overlays: Record<string, unknown> = {};
    for (const id of ['line', 'column', 'combo', 'bar', 'histogram', 'scatter', 'candlestick'] as const) {
      const d = decorate(id);
      decorated[id] = copy(d);
      for (const variant of ['default', 'custom'] as const) {
        const overrides = { ...OVERRIDES[variant], commentPins: [{ n: 1, id: 'p1', label: String(d.labels![1]) }], commentPinTarget: { kind: 'visual', id: 'v1' } };
        legacy.recorded.length = 0;
        legacy.buildChart(canvasStub(), copy(d), id, copy(overrides));
        overlays[`${id} / ${variant}`] = norm(legacy.recorded[0]);
      }
    }
    const table = el('table');
    legacy.buildDataTable(table, copy(DATA.get('table')!));
    const text = (n: Cx) => String(n.textContent ?? '');
    const [thead, tbody] = table.children;
    const [labelTh, ...seriesTh] = thead.children[0].children;
    const dataTable = {
      labelHeader: text(labelTh),
      series: seriesTh.map((th: Cx) => ({ name: text(th.children[1]), color: th.children[0].style.background })),
      rows: tbody.children.map((tr: Cx) => ({ label: text(tr.children[0]), cells: tr.children.slice(1).map(text) })),
    };
    const { wordCloudLayout: legacyLayout } = require(path.join(HUB, 'wordCloudLayout.js')) as { wordCloudLayout: typeof wordCloudLayout };
    const wc = DATA.get('word_cloud')!;
    const words = (wc.labels ?? []).map((l: Cx, i: number) => ({ text: String(l), weight: wc.series![0]!.values[i] }));
    const opts = { width: 600, height: 300, minSize: 11, maxSize: 56, measure: (s: string, px: number) => s.length * px * 0.55, padding: 2 };
    const out = path.join(process.cwd(), 'src/charts/__golden__');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'legacy.json'), encode({
      data, configs, decorated, overlays, dataTable,
      wordCloud: { words, layout: norm(legacyLayout(copy(words), opts)) },
      vizLabels: norm(legacy.VIZ_LABELS),
    }) + '\n');
  });
});
