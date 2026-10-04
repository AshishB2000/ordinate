// DIFFERENTIAL: Format depth (./fmtApply) against the desktop's fmtApply.js +
// fmtColors.js. The same data and the same Format overrides — axis ranges,
// log scales, tick density, hidden axes, a right axis and its measures, series
// colours, value palettes, colour-by-category, and the PROJECT's colour map for
// a category and a split — must build the same Chart.js config, id by id.
// Needs `npm run build:ts` at the repo root.

import { deepStrictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildChart } from './build';
import type { Cx } from './types';

const ROOT = path.resolve(process.cwd(), '..');
const HUB = path.join(ROOT, 'renderer', 'hub');
const require = createRequire(path.join(ROOT, 'package.json'));

const THEME: Record<string, string> = {
  '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6', '--chart-4': '#6366f1',
  '--chart-5': '#64748b', '--chart-6': '#b45309', '--chart-7': '#be185d', '--chart-8': '#4d7c0f',
  '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff', '--text-strong': '#0f1117',
  '--font-ui': 'Inter, system-ui, sans-serif', '--accent': '#2563eb', '--ok': '#059669', '--error': '#e11d48',
};
const computedStyle = () => ({ getPropertyValue: (name: string) => THEME[name] || '' });
const canvasStub = () => ({ parentElement: { clientWidth: 640, clientHeight: 320 } }) as unknown as HTMLCanvasElement;

const SCRIPTS = [
  'chartTraits.js', 'chartPalette.js', 'chartTypeSpec.js', 'chartShapes.js',
  'chartFamiliesExtra.js', 'chartFamiliesPlugins.js', 'chartValueLabels.js',
  'chartAnnotations.js', 'chartEvents.js', 'chartDatasets.js', 'chartScales.js',
  'chartRender.js', 'calcMenu.js', 'fmtApply.js',
];

function slice(file: string, from: string, to: string): string {
  const src = readFileSync(path.join(HUB, file), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`${file}: markers not found`);
  return src.slice(a, b);
}

interface Legacy {
  buildChart(canvas: unknown, data: unknown, type: string, overrides: unknown): unknown;
  fmtAdoptColorMap(p: unknown): void;
  recorded: Cx[];
}

function loadLegacy(): Legacy {
  const recorded: Cx[] = [];
  function Chart(this: Cx, _c: unknown, config: unknown) {
    recorded.push(config);
  }
  const sandbox: Record<string, unknown> = {
    console,
    Chart: Object.assign(Chart, { register: () => {}, defaults: {} }),
    OrdFormat: require(path.join(ROOT, 'src/app/format.js')),
    t: (require(path.join(ROOT, 'scripts/i18nNode.js')) as { englishT: unknown }).englishT,
    matchMedia: () => ({ matches: false }),
    getComputedStyle: computedStyle,
    document: { documentElement: {} },
    currentProjectId: 'p',
    hubFormat: { assignColors: () => Promise.resolve(null), getColorMap: () => Promise.resolve({}) },
    // fmtColors.js binds the shared colour rule through cjsShim's `module`.
    module: { exports: require(path.join(ROOT, 'src/analysis/colorMap.js')) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const formatters = slice('hub.js', 'function _fmtVal(', '// ── Readiness banner');
  const source = [formatters, readFileSync(path.join(HUB, 'fmtColors.js'), 'utf8'), ...SCRIPTS.map((f) => readFileSync(path.join(HUB, f), 'utf8'))].join('\n;\n');
  const api = vm.runInContext(`${source}\n;({ buildChart, fmtAdoptColorMap });`, sandbox) as Legacy;
  return Object.assign(api, { recorded });
}

function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('too deep');
  if (typeof v === 'function') return { fn: (v as { name: string }).name === '_fmtVal' ? 'fmtVal' : (v as { name: string }).name };
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return Array.from(v, (x) => norm(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = norm((v as Record<string, unknown>)[k], depth + 1);
  return out;
}

const DATA = {
  labels: ['East', 'North', 'South', 'West', ''],
  series: [
    { name: 'sum of revenue', values: [1200, 3400, 0, 900, 50] },
    { name: 'sum of profit', values: [300, -120, 40, 220, 5] },
  ],
};
const ONE = { labels: DATA.labels, series: [DATA.series[0]] };
const SPLIT = { labels: ['2024-01', '2024-02', '2024-03'], series: [{ name: 'Furniture', values: [5, 9, 4] }, { name: 'Technology', values: [8, 2, 6] }] };
const MAP = { region: { North: 'chart-5', West: 'chart-2' }, category: { Technology: 'chart-7' } };

const SETS: Record<string, Record<string, unknown>> = {
  axes: { axes: { y: { min: 10, max: 5000, ticks: 'few', format: 'compact' }, x: { hide: true, ticks: 'many' } }, xAxisLabel: 'Region' },
  log: { axes: { y: { log: true } } },
  right: { y2Series: ['sum of profit'], y2AxisLabel: 'Profit', axes: { y2: { format: 'currency', min: -200 } } },
  colours: { seriesColors: { 'sum of profit': 'chart-6' }, measurePalettes: { 'sum of revenue': 'sequential' } },
  diverging: { measurePalettes: { 'sum of profit': 'diverging' } },
};

let legacy: Legacy;
beforeAll(() => {
  legacy = loadLegacy();
  vi.stubGlobal('getComputedStyle', computedStyle);
});
afterAll(() => vi.unstubAllGlobals());

function agree(type: string, data: unknown, overrides: Record<string, unknown>, portOverrides = overrides): void {
  legacy.recorded.length = 0;
  const old = legacy.buildChart(canvasStub(), structuredClone(data), type, structuredClone(overrides));
  const built = buildChart(canvasStub(), structuredClone(data) as never, type, portOverrides);
  if (old === null) {
    expect(built).toBeNull();
    return;
  }
  expect(built && built.kind).toBe('chartjs');
  if (!built || built.kind !== 'chartjs') return;
  deepStrictEqual(norm(built.config), norm(legacy.recorded[0]));
}

describe('Format depth builds the desktop config', () => {
  for (const type of ['column', 'clustered_column', 'combo', 'line', 'area', 'bar', 'stacked_column', 'scatter', 'heatmap', 'pct_stacked_column']) {
    for (const [name, ov] of Object.entries(SETS)) it(`${type} / ${name}`, () => agree(type, DATA, ov));
  }
  for (const type of ['column', 'bar', 'pie', 'donut', 'treemap', 'funnel']) {
    it(`${type} / colour by category`, () => agree(type, ONE, { colorByCategory: true }));
  }

  it('the project colour map: a category and a split column, as main deals them', () => {
    legacy.fmtAdoptColorMap({ id: 'p', colorMap: MAP });
    for (const type of ['pie', 'donut', 'treemap', 'funnel', 'column']) {
      agree(type, ONE, { colorByCategory: true, _colorScope: { projectId: 'p', category: 'region', series: '' } },
        { colorByCategory: true, _colorScope: { category: 'region', series: '', map: MAP } });
    }
    for (const type of ['line', 'clustered_column', 'stacked_area']) {
      agree(type, SPLIT, { _colorScope: { projectId: 'p', category: 'month', series: 'category' } },
        { _colorScope: { category: 'month', series: 'category', map: MAP } });
    }
  });

  it('a log axis over a zero or a negative is drawn linear (both sides)', () => {
    const built = buildChart(canvasStub(), structuredClone(DATA) as never, 'column', { axes: { y: { log: true } } });
    expect(built && built.kind === 'chartjs' && (built.config.options as Cx).scales.y.type).not.toBe('logarithmic');
  });
});
