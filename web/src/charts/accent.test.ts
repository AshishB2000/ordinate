// A Visual analysis chart (chartFormat `accent`, src/analysis/dashboardShapes.ts):
// the first series keeps the accent, every other is drawn in the muted token —
// and a chart coloured per category (a pie's slices) is left as it was.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildChart } from './build';
import type { Cx } from './types';

const THEME: Record<string, string> = {
  '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6', '--border-2': '#ced7e2',
  '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff', '--text-strong': '#0f1117',
};
beforeAll(() => vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (n: string) => THEME[n] || '' })));
afterAll(() => vi.unstubAllGlobals());
const canvas = () => ({ parentElement: { clientWidth: 640, clientHeight: 320 } }) as unknown as HTMLCanvasElement;

const DATA = {
  labels: ['Jan', 'Feb', 'Mar'],
  series: [{ name: 'West', values: [5, 9, 4] }, { name: 'East', values: [8, 2, 6] }, { name: 'North', values: [3, 3, 7] }],
};

const colours = (type: string, overrides: Record<string, unknown>): string[] => {
  const built = buildChart(canvas(), structuredClone(DATA) as never, type, overrides);
  if (!built || built.kind !== 'chartjs') throw new Error('no chart');
  return (built.config.data as Cx).datasets.map((d: Cx) => String(d.borderColor ?? d.backgroundColor));
};

describe('accent + muted', () => {
  it('a line chart: the first series in the accent, the rest muted', () => {
    const c = colours('line', { accent: true });
    expect(c[0]).toContain('#2563eb');
    expect(c.slice(1).every((x) => x.includes('#ced7e2'))).toBe(true);
  });
  it('without it, every series keeps its own colour (negative control)', () => {
    const c = colours('line', {});
    expect(c.some((x) => x.includes('#ced7e2'))).toBe(false);
    expect(new Set(c).size).toBe(3);
  });
  it('a pie is coloured per slice, so it is left alone', () => {
    const built = buildChart(canvas(), { labels: DATA.labels, series: [DATA.series[0]] } as never, 'pie', { accent: true });
    const bg = built && built.kind === 'chartjs' ? (built.config.data as Cx).datasets[0].backgroundColor : [];
    expect(Array.isArray(bg) && bg.some((x: string) => String(x).includes('#ced7e2'))).toBe(false);
  });
});
