// THE GOLDEN RECORDER for the chart figures the browser computes today, before
// the math moves to the server (docs/chart-figures/00-design.md, step 3).
//
// Today's in-app chart is the reference: ./shapes.ts (waterfall steps, Pareto
// order and cumulative %, calendar days), ./format.ts (histogram bins) and
// buildChart (100%-stacked shares; a funnel's "% of top" and a bullet's "% of
// target", as their tooltips print them). Their answers over the cases below
// are recorded ONCE into __golden__/shapes.json, wire-encoded (-0, NaN and
// undefined survive), by
//
//   RECORD_SHAPES=1 npx vitest run src/charts/shapesGolden.test.ts
//
// and never again: without the variable this file checks today's code still
// gives exactly the recorded answers. It goes when the math does; from then on
// scripts/test-chartShapes.ts holds the server's src/analysis/chartShapes.ts to
// the same file with Object.is.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { decode, encode } from '../../../src/server/wire.ts';
import { buildChart } from './build';
import { histogramBins } from './format';
import { calendarCells, paretoShape, waterfallSteps } from './shapes';
import type { ChartSeriesShape, Cx } from './types';

const FILE = path.resolve(process.cwd(), 'src/charts/__golden__/shapes.json');

const s = (name: string, values: Cx[]): ChartSeriesShape => ({ name, values });
const one = (values: Cx[]): ChartSeriesShape[] => [s('sum of revenue', values)];

/** Waterfall: Total rows, negatives, a two-series bridge, an empty group, named totals. */
export const WATERFALL: Array<{ name: string; labels: Cx[]; series: ChartSeriesShape[]; totals?: string[] }> = [
  { name: 'negatives', labels: ['Q1 sales', 'Returns', 'Fees', 'Q2 sales'], series: one([120, -30, -12.5, 80]) },
  { name: 'opening, subtotal and grand total', labels: ['Opening', 'Sales', 'Returns', 'Subtotal', 'Fees', 'Grand total'], series: one([100, 40, -15, null, -5, null]) },
  { name: 'a total with its own value resets the level', labels: ['Opening', 'Sales', 'Total', 'Refunds'], series: one([50, 20, 999, -9]) },
  { name: 'named totals (the drivers tile)', labels: ['Previous total', 'East', 'West', 'Current total'], series: one([10, 5, -3, 12]), totals: ['Previous total', 'Current total'] },
  { name: 'a named total that is not a label', labels: ['a', 'b'], series: one([1, 2]), totals: ['zzz'] },
  { name: 'bridge', labels: ['East', 'West', 'Total', 'North'], series: [s('2023', [0.1, 0.7, 99, null]), s('2024', [0.3, null, 1, 0.2])] },
  { name: 'bridge, falling', labels: ['A', 'B', 'C'], series: [s('Last year', [500, 300, 200]), s('This year', [420, 310, 150])] },
  { name: 'bridge, unnamed series', labels: ['x', 'y'], series: [s('', [1, 2]), s('', [3, 1])] },
  { name: 'an empty group', labels: ['A', 'B', 'C'], series: one([null, null, null]) },
  { name: 'no categories', labels: [], series: one([]) },
  { name: 'a single step', labels: ['Only'], series: one([7]) },
  { name: 'ends on a total', labels: ['a', 'b', 'Total'], series: one([1, 2, null]) },
  { name: 'float drift', labels: ['a', 'b', 'c'], series: one([0.1, 0.2, 0.3]) },
  { name: 'text and nulls are no step', labels: ['a', 'b', 'c'], series: one([3, 'n/a', null]) },
  { name: 'total-looking labels', labels: ['Sub-total', 'total 2024', 'Totally', 'grand Total'], series: one([1, 2, 3, null]) },
];

/** Pareto: unsorted input, ties, negatives, a single bar, nulls, an exact 80%. */
export const PARETO: Array<{ name: string; labels: Cx[]; values: Cx[] }> = [
  { name: 'unsorted', labels: ['C', 'A', 'D', 'B'], values: [10, 50, 5, 35] },
  { name: 'ties keep their order', labels: ['a', 'b', 'c', 'd', 'e'], values: [40, 40, 20, 0, 0] },
  { name: 'negatives and nulls', labels: ['A', 'B', 'C', 'D'], values: [60, -30, 40, null] },
  { name: 'a single bar', labels: ['Only'], values: [42] },
  { name: 'all zero', labels: ['a', 'b'], values: [0, 0] },
  { name: 'nothing positive', labels: ['a', 'b'], values: [-1, -2] },
  { name: 'exact 80% in floats', labels: ['a', 'b', 'c'], values: [0.1, 0.7, 0.2] },
  { name: 'one dominant', labels: ['A', 'B', 'C'], values: [90, 5, 5] },
  { name: 'long tail', labels: Array.from({ length: 30 }, (_, i) => 'c' + i), values: Array.from({ length: 30 }, (_, i) => 1 / (i + 1)) },
  { name: 'numbers as labels', labels: [3, 1, 2], values: [1, 3, 2] },
  { name: 'empty', labels: [], values: [] },
];

/** 100%-stacked: zeros, an all-zero group, negatives, a single series, nulls. */
export const SHARES: Array<{ name: string; labels: Cx[]; series: ChartSeriesShape[] }> = [
  { name: 'two series', labels: ['East', 'West', 'North'], series: [s('Online', [30, 10, 5]), s('Store', [70, 30, 15])] },
  { name: 'zeros and an all-zero group', labels: ['a', 'b', 'c'], series: [s('x', [0, 0, 3]), s('y', [5, 0, 0])] },
  { name: 'negatives', labels: ['a', 'b'], series: [s('x', [-10, 20]), s('y', [30, -5])] },
  { name: 'a single series', labels: ['a', 'b', 'c'], series: [s('only', [1, 2, 0])] },
  { name: 'nulls', labels: ['a', 'b'], series: [s('x', [null, 4]), s('y', [6, null]), s('z', [4, 4])] },
  { name: 'thirds', labels: ['a'], series: [s('x', [1]), s('y', [1]), s('z', [1])] },
];

/** Histogram: what the browser bins today (the first series' numbers). */
export const HISTOGRAM: Array<{ name: string; values: number[] }> = [
  { name: 'empty', values: [] },
  { name: 'one value', values: [5] },
  { name: 'all equal', values: [2, 2, 2] },
  { name: 'spread', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] },
  { name: 'negatives and floats', values: [-3.5, -1.25, 0, 0.1, 2.75, 9.9, 10] },
  { name: 'big', values: Array.from({ length: 200 }, (_, i) => (i * 7919) % 1000) },
];

/** Funnel: each stage against the first, as the tooltip prints it. */
export const FUNNEL: Array<{ name: string; labels: Cx[]; values: Cx[] }> = [
  { name: 'narrowing', labels: ['Visit', 'Cart', 'Pay'], values: [1000, 420, 133] },
  { name: 'a negative and a null', labels: ['a', 'b', 'c'], values: [200, -50, null] },
  { name: 'a zero top', labels: ['a', 'b'], values: [0, 5] },
];

/** Bullet: each row against its target (the second measure, else a fixed target), as the tooltip prints it. */
export const BULLET: Array<{ name: string; labels: Cx[]; series: ChartSeriesShape[]; target?: number }> = [
  { name: 'against a target series', labels: ['A', 'B', 'C'], series: [s('actual', [90, 130, null]), s('target', [100, 100, 80])] },
  { name: 'against a fixed target', labels: ['A', 'B'], series: [s('actual', [40, 80])], target: 100 },
  { name: 'a zero and a missing target', labels: ['A', 'B'], series: [s('actual', [40, 80]), s('target', [0, null])] },
];

/** Calendar: days as written, two labels on one day, impossible dates. */
export const CALENDAR: Array<{ name: string; labels: Cx[]; values: Cx[] }> = [
  { name: 'a week', labels: ['2024-01-01', '2024-01-02', '2024-01-04', '2024-01-07', '2024-01-08'], values: [5, 7, 3, 1, 9] },
  { name: 'two labels on one day', labels: ['2024-01-02T23:30:00-05:00', '2024-01-02 08:00', '2024-01-03T00:00:00Z'], values: [1, 2, 4] },
  { name: 'a null beside a value on one day', labels: ['2024-03-01', '2024-03-01T12:00', '2024-03-02'], values: [null, 6, null] },
  { name: 'across a leap day', labels: ['2024-02-28', '2024-02-29', '2024-03-01'], values: [1, 2, 3] },
  { name: 'not dates', labels: ['North', 'South'], values: [1, 2] },
  { name: 'an impossible date', labels: ['2023-02-30'], values: [1] },
  { name: 'a span past twenty years', labels: ['1990-01-01', '2024-01-01'], values: [1, 2] },
];

// buildChart reads theme tokens and sizes off a canvas: the same stubs as ./legacy.test.ts.
const THEME: Record<string, string> = { '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--ok': '#059669', '--error': '#e11d48' };
const canvasStub = () => ({ parentElement: { clientWidth: 640, clientHeight: 320 } }) as unknown as HTMLCanvasElement;
beforeAll(() => vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (n: string) => THEME[n] || '' })));
afterAll(() => vi.unstubAllGlobals());

function config(type: string, labels: Cx[], series: ChartSeriesShape[], overrides: Cx = {}): Cx {
  const built = buildChart(canvasStub(), { labels, series }, type, overrides);
  return built && built.kind === 'chartjs' ? built.config : null;
}
const tooltips = (cfg: Cx, n: number): string[] =>
  cfg ? Array.from({ length: n }, (_, i) => String(cfg.options.plugins.tooltip.callbacks.label({ dataIndex: i, datasetIndex: 1, raw: null, dataset: {} }))) : [];

function record(): Record<string, Cx> {
  return {
    waterfall: Object.fromEntries(WATERFALL.map((c) => [c.name, waterfallSteps(c.labels, c.series, c.totals)])),
    pareto: Object.fromEntries(PARETO.map((c) => [c.name, paretoShape(c.labels, c.values)])),
    shares: Object.fromEntries(SHARES.map((c) => [c.name, config('pct_stacked_column', c.labels, c.series).data.datasets.map((d: Cx) => d.data)])),
    histogram: Object.fromEntries(HISTOGRAM.map((c) => [c.name, histogramBins(c.values)])),
    funnel: Object.fromEntries(FUNNEL.map((c) => [c.name, tooltips(config('funnel', c.labels, [s('n', c.values)]), c.values.length)])),
    bullet: Object.fromEntries(BULLET.map((c) => [c.name, tooltips(config('bullet', c.labels, c.series, c.target === undefined ? {} : { bulletTarget: c.target }), c.labels.length)])),
    calendar: Object.fromEntries(CALENDAR.map((c) => [c.name, calendarCells(c.labels, c.values)])),
  };
}

it('today\'s in-app figures are the recorded ones', () => {
  const now = record();
  if (process.env.RECORD_SHAPES === '1') writeFileSync(FILE, encode(now) + '\n');
  expect(encode(decode(readFileSync(FILE, 'utf8')))).toBe(encode(now));
  // It compares something: every family recorded every case.
  const g = decode(readFileSync(FILE, 'utf8')) as Record<string, Record<string, unknown>>;
  expect(Object.keys(g.waterfall)).toHaveLength(WATERFALL.length);
  expect(Object.keys(g.shares)).toHaveLength(SHARES.length);
  expect((g.funnel['narrowing'] as string[])[1]).toMatch(/42%/);
});
