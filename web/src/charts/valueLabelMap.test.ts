// Value labels in the chart engine (semantic layer PR 06): the server sends raw labels and series names with
// `valueLabels` pairs beside them ("EU" → "Europe"). Every surface the engine DRAWS says the label — the axis, the
// legend, a table, a copied TSV, the figure list, a report picture — and every gesture sends the STORED value back:
// a click, a pin, a right-click, a custom order, a colour. Without pairs every output is today's.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildChart } from './build';
import { renderChartPng } from './png';
import { DIM_ALPHA, selectionPlugin } from './selection';
import { tableModel } from './table';
import type { ChartDataShape, Cx } from './types';
import { drawnLabels, shownData } from './valueLabelMap';
import { dataToTsv } from '../features/visuals/ChartControls';
import { serverLabel } from '../features/analyses/VisualTile';
import { pointAt } from '../features/analytics/explain/pointAt';
import type { ChartHandle } from './Chart';

// The theme tokens buildChart reads off its canvas (fmt.test.ts's stub).
const THEME: Record<string, string> = { '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6', '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff', '--text-strong': '#0f1117', '--font-ui': 'Inter' };
const computedStyle = () => ({ getPropertyValue: (name: string) => THEME[name] || '' });
const canvasStub = () => ({ parentElement: { clientWidth: 640, clientHeight: 320 } }) as unknown as HTMLCanvasElement;
beforeAll(() => vi.stubGlobal('getComputedStyle', computedStyle));
afterAll(() => vi.unstubAllGlobals());

// A report picture is drawn off-screen by Chart.js: the instance it is handed is what it draws.
const drawn = vi.hoisted(() => ({ configs: [] as Cx[] }));
vi.mock('./loadChartJs', () => ({
  loadChartJs: async () =>
    class {
      constructor(_canvas: unknown, config: Cx) {
        drawn.configs.push(config);
      }
      update() {}
      destroy() {}
    },
}));

const EU: [string, string] = ['EU', 'Europe'];
const DATA: ChartDataShape = { labels: ['EU', 'NA'], series: [{ name: 'sum', values: [2, 1] }], valueLabels: { category: [EU] } };
const SPLIT: ChartDataShape = { labels: ['gold', 'silver'], series: [{ name: 'EU', values: [2, 1] }, { name: 'NA', values: [3, 4] }], valueLabels: { series: [EU, ['NA', 'North America']] } };
const config = (data: ChartDataShape, overrides: Cx = {}, type = 'column'): Cx => {
  const built = buildChart(canvasStub(), data, type, overrides);
  if (built?.kind !== 'chartjs') throw new Error(`not a Chart.js chart: ${built?.kind}`);
  return built.config;
};
const unlabelled = ({ valueLabels: _pairs, ...rest }: ChartDataShape): ChartDataShape => rest;

describe('the chart draws the labels', () => {
  it('a category axis says the label; a value without one says itself', () => {
    expect(config(DATA).data.labels).toEqual(['Europe', 'NA']);
  });

  it('a split legend names each series by its label', () => {
    expect(config(SPLIT).data.datasets.map((d: Cx) => d.label)).toEqual(['Europe', 'North America']);
  });

  it('a custom order is stored by value, and still applies', () => {
    expect(config(DATA, { sort: 'custom', sortOrder: ['NA', 'EU'] }).data.labels).toEqual(['NA', 'Europe']);
  });

  it('A→Z on a labelled text column compares what is drawn; Z→A too', () => {
    const data = { labels: ['EU', 'NA', 'APAC'], series: [{ name: 'sum', values: [1, 2, 3] }], valueLabels: { category: [['EU', 'Zone Europe']] as [string, string][] } };
    expect(config(data, { sort: 'label_asc' }).data.labels).toEqual(['APAC', 'NA', 'Zone Europe']);
    expect(config(data, { sort: 'label_desc' }).data.labels).toEqual(['Zone Europe', 'NA', 'APAC']);
    // NEGATIVE CONTROL: the same axis without labels sorts by its stored values.
    expect(config(unlabelled(data), { sort: 'label_asc' }).data.labels).toEqual(['APAC', 'EU', 'NA']);
  });

  it('a month axis keeps its raw order (it has no labels): Jan before Apr, not A→Z of the text', () => {
    const months = { labels: ['2023-04-01', '2023-01-01'], series: [{ name: 'sum', values: [1, 2] }] };
    expect(config(months, { sort: 'label_asc' }).data.labels).toEqual(drawnLabels(['2023-01-01', '2023-04-01']));
  });

  it('a series colour is stored by value and still paints the labelled series', () => {
    const colours = (data: ChartDataShape, overrides: Cx = { seriesColors: { NA: 'chart-3' } }) => config(data, overrides, 'line').data.datasets.map((d: Cx) => d.borderColor);
    expect(colours(SPLIT)[1]).toBe('#14b8a6');
    expect(colours(SPLIT)).toEqual(colours(unlabelled(SPLIT)));
    expect(colours(SPLIT, {})[1]).not.toBe('#14b8a6'); // NEGATIVE CONTROL: the colour is the override's
  });

  it('a word cloud draws its words by their labels', () => {
    const built = buildChart(canvasStub(), DATA, 'word_cloud');
    expect(built?.kind === 'wordCloud' && built.labels).toEqual(['Europe', 'NA']);
  });

  it('without pairs the config is today’s, key for key', () => {
    const plain = { labels: ['EU', 'NA'], series: [{ name: 'sum', values: [2, 1] }] };
    const norm = (c: Cx) => JSON.stringify(c, (_k, v) => (typeof v === 'function' ? String(v.name) : v));
    expect(norm(config({ ...plain, valueLabels: undefined }))).toBe(norm(config(plain)));
    expect(config(plain).data.labels).toEqual(['EU', 'NA']);
  });
});

describe('what leaves the chart as text says the label', () => {
  it('the data table reads the labels', () => {
    const m = tableModel(DATA);
    expect(m.rows.map((r) => r.label)).toEqual(['Europe', 'NA']);
    expect(tableModel(SPLIT).series.map((x) => x.name)).toEqual(['Europe', 'North America']);
  });

  it('a copied TSV starts its rows with the label', () => {
    expect(dataToTsv(DATA).split('\n')[1]).toMatch(/^Europe\t/);
    expect(dataToTsv(SPLIT).split('\n')[0]).toBe('Label\tEurope\tNorth America');
  });

  it('NEGATIVE CONTROL: without pairs the table, the TSV and the reply are today’s', () => {
    const plain = unlabelled(DATA);
    expect(shownData(plain)).toBe(plain);
    expect(dataToTsv(plain).split('\n')[1]).toMatch(/^EU\t/);
    expect(tableModel(plain).rows[0].label).toBe('EU');
  });

  it('a report picture draws the labels, in the stored custom order', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect() {}, drawImage() {}, fillStyle: '' } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,');
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
    drawn.configs.length = 0;
    expect(await renderChartPng('column', DATA, { sort: 'custom', sortOrder: ['NA', 'EU'] })).toBe('data:image/png;base64,');
    expect(drawn.configs[0].data.labels).toEqual(['NA', 'Europe']);
    vi.stubGlobal('getComputedStyle', computedStyle);
  });
});

describe('every gesture sends the stored value', () => {
  it('serverLabel: a drawn label goes back to its value', () => {
    expect(serverLabel(['EU', 'NA'], 'Europe', { category: [EU] })).toBe('EU');
    expect(serverLabel(['EU', 'NA'], 'NA', { category: [EU] })).toBe('NA');
    // NEGATIVE CONTROL: without the pairs a drawn label is not a value the server sent.
    expect(serverLabel(['EU', 'NA'], 'Europe')).toBe('Europe');
  });

  const chartAt = (labels: string[], sets: string[], hit = { index: 0, datasetIndex: 0 }) =>
    ({ config: { type: 'bar' }, data: { labels, datasets: sets.map((label) => ({ label })) }, getElementsAtEventForMode: () => [hit] }) as unknown as ChartHandle;

  it('pointAt: a bar drawn as Europe is the bucket EU', () => {
    expect(pointAt(chartAt(['Europe', 'NA'], ['sum']), new MouseEvent('contextmenu'), ['EU', 'NA'], DATA.valueLabels)).toEqual({ bucket: 'EU' });
  });

  it('pointAt: a split drawn as Europe is the series EU', () => {
    const p = pointAt(chartAt(['gold', 'silver'], ['Europe', 'North America'], { index: 1, datasetIndex: 1 }), new MouseEvent('contextmenu'), ['gold', 'silver'], SPLIT.valueLabels);
    expect(p).toEqual({ bucket: 'silver', series: 'NA' });
  });

  it('NEGATIVE CONTROL: pointAt without pairs names what is drawn, as before', () => {
    expect(pointAt(chartAt(['EU', 'NA'], ['EU', 'NA'], { index: 0, datasetIndex: 1 }), new MouseEvent('contextmenu'), ['EU', 'NA'])).toEqual({ bucket: 'EU', series: 'NA' });
  });
});

/** A mark that records the alpha it was painted with (selection.test.ts's). */
class Mark {
  a: number | null = null;
  x = 1;
  y = 1;
  draw(ctx: Cx) {
    this.a = ctx.globalAlpha;
  }
}

describe('click-to-filter dims only what was not picked', () => {
  function alphas(sel: { categories?: string[]; series?: string[] }, data: ChartDataShape) {
    const cfg = config(data);
    const labels: string[] = cfg.data.labels;
    const sets: string[] = cfg.data.datasets.map((d: Cx) => d.label);
    const raw = data.labels as string[];
    const plugin = selectionPlugin(sel, raw, drawnLabels(raw, data.valueLabels), data.valueLabels?.series);
    const stack: number[] = [];
    const ctx: Cx = { globalAlpha: 1, save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop() ?? 1; }, beginPath() {}, arc() {}, fill() {} };
    const metas = sets.map(() => ({ data: labels.map(() => new Mark()), hidden: false }));
    const chart: Cx = { ctx, data: { labels, datasets: sets.map((label) => ({ label })) }, getDatasetMeta: (i: number) => metas[i] };
    metas.forEach((meta, index) => {
      plugin.beforeDatasetDraw(chart, { index, meta });
      for (const el of meta.data) el.draw(ctx);
      plugin.afterDatasetDraw(chart, { index, meta });
    });
    return metas.map((m) => m.data.map((el) => el.a));
  }

  it('a click on a labelled category picks it, by its stored value', () => {
    expect(alphas({ categories: ['EU'] }, DATA)).toEqual([[1, DIM_ALPHA]]);
  });

  it('a click on a labelled legend entry dims only the other series', () => {
    expect(alphas({ series: ['EU'] }, SPLIT)).toEqual([
      [1, 1],
      [DIM_ALPHA, DIM_ALPHA],
    ]);
  });

  it('NEGATIVE CONTROL: unlabelled, the same pick dims the same series', () => {
    expect(alphas({ series: ['EU'] }, unlabelled(SPLIT))).toEqual([
      [1, 1],
      [DIM_ALPHA, DIM_ALPHA],
    ]);
  });
});
