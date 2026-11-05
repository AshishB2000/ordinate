import { describe, expect, it } from 'vitest';
import { buildChartDatasets } from './datasets';
import type { ChartCtx } from './types';

// A target series is the server's (visualsOverlay → targetSeries): drawn as a stepped dashed line, on a bar chart too.
const ctx = (over: Record<string, unknown>): ChartCtx => ({
  labels: ['Jan', 'Feb'],
  series: [{ name: 'Revenue', values: [10, 20] }, { name: 'Target', values: [15, 15], role: 'overlay', target: true }],
  opts: {}, overrides: {}, palette: ['#1f6feb', '#e5484d'], fmt: String, lineTension: 0.3,
  gridColor: '#ddd', surfColor: '#fff', fontFamily: 'sans-serif',
  isLine: false, isHoriz: false,
  ...over,
} as unknown as ChartCtx);

describe('the target series', () => {
  for (const [name, isLine] of [['a bar chart', false], ['a line chart', true]] as const) {
    it(`is a stepped dashed line on ${name}`, () => {
      const target = buildChartDatasets(ctx({ isLine }))!.datasets[1];
      expect(target.type).toBe('line');
      expect(target.stepped).toBe('middle');
      expect(target.borderDash).toEqual([4, 3]);
      expect(target.pointRadius).toBe(0);
      expect(target.fill).toBe(false);
      expect(target.data).toEqual([15, 15]);
    });
  }

  it('NEGATIVE CONTROL: a plain overlay keeps today\'s dataset', () => {
    const series = [{ name: 'Revenue', values: [10, 20] }, { name: 'Revenue · last year', values: [8, 9], role: 'overlay' }];
    const bar = buildChartDatasets(ctx({ series }))!.datasets[1];
    expect(bar.type).toBeUndefined();
    expect(bar.stepped).toBeUndefined();
    const line = buildChartDatasets(ctx({ series, isLine: true }))!.datasets[1];
    expect(line.stepped).toBeUndefined();
    expect(line.borderDash).toEqual([5, 4]);
  });
});
