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
import { BULLET, CALENDAR, FUNNEL, HISTOGRAM, PARETO, SHARES, WATERFALL } from '../../../scripts/fixtures/figureCases.ts';

const FILE = path.resolve(process.cwd(), 'src/charts/__golden__/shapes.json');
const s = (name: string, values: Cx[]): ChartSeriesShape => ({ name, values });

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
