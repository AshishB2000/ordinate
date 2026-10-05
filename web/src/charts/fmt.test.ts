// DIFFERENTIAL: Format depth (./fmtApply) against the desktop's fmtApply.js +
// fmtColors.js, as recorded at the T8.1 cutover (__golden__/fmt.json). The
// same data and the same Format overrides — axis ranges,
// log scales, tick density, hidden axes, a right axis and its measures, series
// colours, value palettes, colour-by-category, and the PROJECT's colour map for
// a category and a split — must build the same Chart.js config, id by id.

import { deepStrictEqual } from 'node:assert/strict';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildChart } from './build';
import type { Cx } from './types';
import { golden } from '../test-golden';

const THEME: Record<string, string> = {
  '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6', '--chart-4': '#6366f1',
  '--chart-5': '#64748b', '--chart-6': '#b45309', '--chart-7': '#be185d', '--chart-8': '#4d7c0f',
  '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff', '--text-strong': '#0f1117',
  '--font-ui': 'Inter, system-ui, sans-serif', '--accent': '#2563eb', '--ok': '#059669', '--error': '#e11d48',
};
const computedStyle = () => ({ getPropertyValue: (name: string) => THEME[name] || '' });
const canvasStub = () => ({ parentElement: { clientWidth: 640, clientHeight: 320 } }) as unknown as HTMLCanvasElement;

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

const G = golden<Record<string, unknown>>('src/charts/__golden__/fmt.json');
beforeAll(() => vi.stubGlobal('getComputedStyle', computedStyle));
afterAll(() => vi.unstubAllGlobals());

function agree(type: string, data: unknown, overrides: Record<string, unknown>, portOverrides = overrides): void {
  const key = type + ' ' + JSON.stringify(overrides) + ' ' + JSON.stringify(data);
  expect(key in G, `recorded: ${key}`).toBe(true);
  const want = G[key];
  const built = buildChart(canvasStub(), structuredClone(data) as never, type, portOverrides);
  if (want === null) {
    expect(built).toBeNull();
    return;
  }
  expect(built && built.kind).toBe('chartjs');
  if (!built || built.kind !== 'chartjs') return;
  deepStrictEqual(norm(built.config), want);
}

describe('Format depth builds the desktop config', () => {
  for (const type of ['column', 'clustered_column', 'combo', 'line', 'area', 'bar', 'stacked_column', 'scatter', 'heatmap', 'pct_stacked_column']) {
    for (const [name, ov] of Object.entries(SETS)) it(`${type} / ${name}`, () => agree(type, DATA, ov));
  }
  for (const type of ['column', 'bar', 'pie', 'donut', 'treemap', 'funnel']) {
    it(`${type} / colour by category`, () => agree(type, ONE, { colorByCategory: true }));
  }

  it('the project colour map: a category and a split column, as main deals them', () => {
    for (const type of ['pie', 'donut', 'treemap', 'funnel', 'column']) {
      agree(type, ONE, { colorByCategory: true, _colorScope: { projectId: 'p', category: 'region', series: '' } },
        { colorByCategory: true, _colorScope: { category: 'region', series: '', map: MAP } });
    }
    for (const type of ['line', 'clustered_column', 'stacked_area']) {
      agree(type, SPLIT, { _colorScope: { projectId: 'p', category: 'month', series: 'category' } },
        { _colorScope: { category: 'month', series: 'category', map: MAP } });
    }
  });

  it('a log axis over a zero or a negative is drawn linear', () => {
    const built = buildChart(canvasStub(), structuredClone(DATA) as never, 'column', { axes: { y: { log: true } } });
    expect(built && built.kind === 'chartjs' && (built.config.options as Cx).scales.y.type).not.toBe('logarithmic');
  });
});

describe('the golden comparison', () => {
  it('a broken port would be caught (negative control)', () => {
    const built = buildChart(canvasStub(), structuredClone(DATA) as never, 'column', {});
    const want = G['bar ' + JSON.stringify(SETS.axes) + ' ' + JSON.stringify(DATA)];
    expect(() => deepStrictEqual(norm(built && built.kind === 'chartjs' ? built.config : null), want)).toThrow();
  });
});
