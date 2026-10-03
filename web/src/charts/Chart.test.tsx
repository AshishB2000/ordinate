// <Chart>'s lifecycle against a recording stand-in for Chart.js (jsdom has no
// canvas to draw on): one instance per mount, update() in place for new data
// of the same Chart.js type, a new instance for a new type, destroy on unmount,
// and the designed empty / error states.

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chart } from './Chart';
import type { ChartDataShape, Cx } from './types';

const log: string[] = [];
let instances: Cx[] = [];
let fail = false;

class FakeChart {
  config: Cx;
  data: Cx;
  options: Cx;
  canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement, config: Cx) {
    this.canvas = canvas;
    this.config = config;
    this.data = config.data;
    this.options = config.options;
    log.push(`create ${config.type}`);
    instances.push(this);
  }
  update() {
    log.push(`update ${this.config.type} ${this.data.labels.join(',')}`);
  }
  resize() {}
  destroy() {
    log.push(`destroy ${this.config.type}`);
  }
}

vi.mock('./loadChartJs', () => ({
  loadChartJs: async () => {
    if (fail) throw new Error('chunk failed to load');
    return FakeChart;
  },
}));

const DATA: ChartDataShape = { labels: ['A', 'B', 'C'], series: [{ name: 'Revenue', values: [3, 1, 2] }] };
const MORE: ChartDataShape = { labels: ['A', 'B', 'C', 'D'], series: [{ name: 'Revenue', values: [3, 1, 2, 5] }] };

beforeEach(() => {
  log.length = 0;
  instances = [];
  fail = false;
});

describe('<Chart>', () => {
  it('creates once, updates in place, recreates for a new Chart.js type, destroys on unmount', async () => {
    const { rerender, unmount } = render(<Chart type="column" data={DATA} label="Revenue" />);
    await waitFor(() => expect(log).toEqual(['create bar']));
    expect(screen.getByRole('img', { name: 'Revenue' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<Chart type="column" data={MORE} label="Revenue" />);
    await waitFor(() => expect(log).toEqual(['create bar', 'update bar A,B,C,D']));
    expect(instances).toHaveLength(1);

    // pareto is also a Chart.js bar: still the same instance.
    rerender(<Chart type="pareto" data={MORE} label="Revenue" />);
    await waitFor(() => expect(log).toHaveLength(3));
    expect(instances).toHaveLength(1);

    rerender(<Chart type="line" data={MORE} label="Revenue" />);
    await waitFor(() => expect(log.slice(3)).toEqual(['destroy bar', 'create line']));

    unmount();
    expect(log.at(-1)).toBe('destroy line');
  });

  it('swaps the inline plugins on update, detaching the old ones', async () => {
    const { rerender } = render(<Chart type="column" data={DATA} />);
    await waitFor(() => expect(instances).toHaveLength(1));
    const plugins: Cx[] = instances[0].config.plugins;
    const before = [...plugins];
    const detached = vi.fn();
    for (const p of before) p.afterDestroy = detached;
    rerender(<Chart type="column" data={MORE} />);
    await waitFor(() => expect(log).toContain('update bar A,B,C,D'));
    expect(detached).toHaveBeenCalledTimes(before.length);
    expect(instances[0].config.plugins).toBe(plugins); // the same array, new contents
    expect(plugins.every((p) => !before.includes(p))).toBe(true);
  });

  it('shows the empty state when there is nothing to draw', async () => {
    render(<Chart type="column" data={{ labels: [], series: [] }} />);
    expect(await screen.findByText('Nothing to draw')).toBeTruthy();
    expect(log).toEqual([]);
  });

  it('shows the error state when Chart.js cannot be loaded', async () => {
    fail = true;
    render(<Chart type="column" data={DATA} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('chunk failed to load')).toBeTruthy();
  });

  it('rebuilds when the theme changes', async () => {
    render(<Chart type="column" data={DATA} />);
    await waitFor(() => expect(log).toEqual(['create bar']));
    document.documentElement.dataset.theme = 'dark';
    await waitFor(() => expect(log).toEqual(['create bar', 'update bar A,B,C']));
  });
});
