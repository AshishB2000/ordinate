// The in-app charts draw the SERVER's figures (docs/chart-figures/00-design.md).
//
// The browser used to work them out; its answers were recorded before the math
// moved (__golden__/shapes.json, over scripts/fixtures/figureCases.ts). Here
// the chart engine is given the figures src/analysis/chartShapes.ts computes
// for the same cases — as `visual:data` would send them — and must draw exactly
// what it drew before: the same waterfall steps, Pareto order and line, bins,
// tooltip text and calendar cells, with Object.is at every number. Two
// deliberate changes: a 100%-stacked bar is the unrounded share (each rounds
// to the whole percent drawn before), and a type that needs figures draws
// nothing without them, rather than working them out.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chartShapes } from '../../../src/analysis/chartShapes.ts';
import { decode } from '../../../src/server/wire.ts';
import { BULLET, CALENDAR, FUNNEL, HISTOGRAM, PARETO, SHARES, WATERFALL } from '../../../scripts/fixtures/figureCases.ts';
import { buildChart } from './build';
import { calendarCells, paretoFromFigures, sortedFigures, waterfallFromFigures } from './shapes';
import type { ChartDataShape, ChartSeriesShape, Cx } from './types';

type Golden = Record<string, Record<string, Cx>>;
const G = decode(readFileSync(path.resolve(process.cwd(), 'src/charts/__golden__/shapes.json'), 'utf8')) as Golden;

/** Deep equality, Object.is at every leaf: the first difference, or ''. */
function diff(a: unknown, b: unknown, at = '$'): string {
  if (Object.is(a, b)) return '';
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = diff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    if (JSON.stringify(ka) !== JSON.stringify(Object.keys(b).sort())) return `${at}: keys differ`;
    for (const k of ka) { const d = diff((a as Cx)[k], (b as Cx)[k], `${at}.${k}`); if (d) return d; }
    return '';
  }
  return `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

const THEME: Record<string, string> = { '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--ok': '#059669', '--error': '#e11d48' };
const canvasStub = () => ({ parentElement: { clientWidth: 640, clientHeight: 320 } }) as unknown as HTMLCanvasElement;
beforeAll(() => vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (n: string) => THEME[n] || '' })));
afterAll(() => vi.unstubAllGlobals());

const s = (name: string, values: Cx[]): ChartSeriesShape => ({ name, values });
/** What `visual:data` answers for a chart drawn as `type`: the series and the server's figures for it. */
function reply(type: string, labels: Cx[], series: ChartSeriesShape[], ask: Cx = {}): ChartDataShape {
  const figures = chartShapes(type, { labels, series }, ask);
  return { labels, series, ...(figures ? { figures } : {}) };
}
function config(type: string, data: ChartDataShape, overrides: Cx = {}): Cx {
  const built = buildChart(canvasStub(), data, type, overrides);
  return built && built.kind === 'chartjs' ? built.config : null;
}
const tooltips = (cfg: Cx, n: number): string[] =>
  cfg ? Array.from({ length: n }, (_, i) => String(cfg.options.plugins.tooltip.callbacks.label({ dataIndex: i, datasetIndex: 1, raw: null, dataset: {} }))) : [];

describe('the in-app chart draws the server\'s figures, and draws what it drew before', () => {
  it('waterfall: every step, level and end', () => {
    for (const c of WATERFALL) {
      const f = chartShapes('waterfall', { labels: c.labels, series: c.series }, { waterfallTotals: c.totals });
      const shape = f ? waterfallFromFigures(f.waterfall!, c.labels) : null;
      const g = G.waterfall[c.name];
      expect(shape ? diff(shape, g) : (g.kind.length ? 'figures missing' : ''), c.name).toBe('');
    }
  });

  it('Pareto: the order, the bars and the cumulative line', () => {
    for (const c of PARETO) {
      const f = chartShapes('pareto', { labels: c.labels, series: [s('v', c.values)] });
      const shape = f ? paretoFromFigures(f.pareto!, c.labels, c.values) : null;
      const g = G.pareto[c.name];
      expect(shape ? diff(shape, g) : (g.src.length ? 'figures missing' : ''), c.name).toBe('');
    }
  });

  it('100%-stacked: the bars are the server\'s unrounded shares, each the whole percent it was', () => {
    for (const c of SHARES) {
      const data = reply('pct_stacked_column', c.labels, c.series);
      const drawn: number[][] = config('pct_stacked_column', data).data.datasets.map((d: Cx) => d.data);
      expect(diff(drawn, data.figures!.sharePct), c.name).toBe('');
      expect(diff(drawn.map((r) => r.map((v) => Math.round(v))), G.shares[c.name]), c.name).toBe('');
    }
  });

  it('histogram: the server\'s bins, labelled and counted as before', () => {
    for (const c of HISTOGRAM) {
      if (!c.values.length) continue; // nothing to draw, then and now
      const cfg = config('histogram', reply('histogram', c.values.map((_, i) => i), [s('n', c.values)]));
      expect(diff({ labels: cfg.data.labels, counts: cfg.data.datasets[0].data }, G.histogram[c.name]), c.name).toBe('');
    }
  });

  it('funnel and bullet: the tooltips print the server\'s percentages exactly as they printed their own', () => {
    for (const c of FUNNEL) {
      const cfg = config('funnel', reply('funnel', c.labels, [s('n', c.values)]));
      expect(tooltips(cfg, c.values.length), c.name).toEqual(G.funnel[c.name]);
    }
    for (const c of BULLET) {
      const ov = c.target === undefined ? {} : { bulletTarget: c.target };
      const cfg = config('bullet', reply('bullet', c.labels, c.series, ov), ov);
      expect(tooltips(cfg, c.labels.length), c.name).toEqual(G.bullet[c.name]);
    }
  });

  it('calendar: the same cells, weeks, month marks and range', () => {
    for (const c of CALENDAR) {
      const f = chartShapes('calendar', { labels: c.labels, series: [s('v', c.values)] });
      expect(diff(f ? calendarCells(f.calendar!) : null, G.calendar[c.name]), c.name).toBe('');
    }
  });

  it('a 100%-stacked chart sorted by value keeps each share with its own category', () => {
    const data = reply('pct_stacked_bar', ['a', 'b', 'c'], [s('x', [1, 30, 5]), s('y', [3, 10, 5])]);
    const cfg = config('pct_stacked_bar', data, { sort: 'desc' });
    expect(cfg.data.labels).toEqual(['b', 'c', 'a']);
    expect(cfg.data.datasets[0].data).toEqual([75, 50, 25]);
  });

  it('a bullet sorted by value: each row\'s tooltip still says its own % of target', () => {
    const series = [s('actual', [40, 90, 60]), s('target', [100, 100, 100])];
    const cfg = config('bullet', reply('bullet', ['A', 'B', 'C'], series), { sort: 'desc' });
    expect(cfg.data.labels).toEqual(['B', 'C', 'A']);
    expect(tooltips(cfg, 3)).toEqual(['90 of 100 target (90%)', '60 of 100 target (60%)', '40 of 100 target (40%)']);
  });

  it('sortedFigures permutes every per-category array and remaps every label index, one way', () => {
    const f = { sharePct: [[1, 2, 3]], bullet: { ofTargetPct: [10, 20, 30] }, funnel: { ofTopPct: [[100, 50, 25]] },
      pareto: { order: [2, 0, 1], cumPct: [1, 2, 3], count80: 1, total: 6, positives: 3 },
      waterfall: { from: 0, to: 1, steps: [{ label: 'a', start: 0, end: 1, value: 1, kind: 'up' as const, src: 0 }, { label: 'T', start: 0, end: 1, value: 1, kind: 'end' as const, src: -1 }] } };
    const g = sortedFigures(f, [2, 0, 1]);
    expect(g.sharePct).toEqual([[3, 1, 2]]);
    expect(g.bullet!.ofTargetPct).toEqual([30, 10, 20]);
    expect(g.funnel!.ofTopPct).toEqual([[25, 100, 50]]);
    expect(g.pareto!.order).toEqual([0, 1, 2]); // label 2 is now at 0, label 0 at 1, label 1 at 2
    expect(g.waterfall!.steps.map((x) => x.src)).toEqual([1, -1]);
  });

  it('without its figures, a figure type draws nothing — it never works them out', () => {
    const plain = { labels: ['a', 'b'], series: [s('x', [1, 2]), s('y', [3, 4])] };
    for (const type of ['waterfall', 'pareto', 'pct_stacked_column', 'pct_stacked_bar', 'histogram', 'calendar']) {
      expect(buildChart(canvasStub(), plain, type, {}), type).toBeNull();
    }
    // A funnel or a bullet is its own figures; only the percent in the tooltip is the server's.
    expect(tooltips(config('funnel', { labels: ['a', 'b'], series: [s('n', [10, 4])] }), 2)).toEqual(['10', '4']);
    expect(config('column', plain)).not.toBeNull();
  });

  it('compares something (negative control): figures one hair off draw a different chart', () => {
    const right = reply('waterfall', ['a', 'b'], [s('v', [1, 2])]);
    const off = reply('waterfall', ['a', 'b'], [s('v', [1, 2])]);
    off.figures!.waterfall!.steps[1].end += 1e-9;
    expect(diff(waterfallFromFigures(off.figures!.waterfall!, ['a', 'b']), waterfallFromFigures(right.figures!.waterfall!, ['a', 'b']))).not.toBe('');
  });
});
