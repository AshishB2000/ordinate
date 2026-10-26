import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Overrides } from '../../charts/types';

// What each draw asked buildChart for, and the accent the canvas reads (jsdom resolves no custom property).
const h = vi.hoisted(() => ({ built: [] as Overrides[], accent: '#7c3aed' }));
vi.mock('../../charts/build', () => ({
  buildChart: (_canvas: unknown, _data: unknown, _type: string, overrides: Overrides) => {
    h.built.push(overrides);
    return { kind: 'chart', config: {} };
  },
}));
vi.mock('../../charts/loadChartJs', () => ({
  loadChartJs: async () =>
    class {
      options = {};
      update() {}
      destroy() {}
    },
}));
vi.mock('../../charts/palette', async (orig) => ({
  ...(await orig<typeof import('../../charts/palette')>()),
  getCSSVar: (name: string) => (name === '--chart-accent' ? h.accent : ''),
}));

const { ChartThumb, accentOverrides } = await import('./Thumb');

const DATA = { labels: ['a', 'b'], series: [{ name: 'Revenue', values: [1, 2] }] };
const OWN: Overrides = { color: '#e11d48', seriesColors: { Revenue: '#be185d' }, colorByCategory: true, measurePalettes: { Revenue: 'sequential' }, _colorScope: { category: 'c', series: '', map: {} }, stacked: true };

afterEach(() => {
  cleanup();
  h.built.length = 0;
  delete document.documentElement.dataset.accent;
});

describe('accentOverrides', () => {
  it("drops the visual's own colours, seeds the palette from the accent, and keeps everything else", () => {
    expect(accentOverrides(OWN, '#7c3aed')).toEqual({ color: '#7c3aed', stacked: true });
    expect(OWN.seriesColors).toEqual({ Revenue: '#be185d' }); // the visual's own overrides are not touched
  });

  it('no #rrggbb accent: the theme palette, still without the own colours', () => {
    expect(accentOverrides(OWN, '')).toEqual({ stacked: true });
    expect(accentOverrides(OWN, 'var(--x)')).toEqual({ stacked: true });
  });
});

describe('ChartThumb', () => {
  it("draws with the visual's own colours by default (the Visuals gallery, Explore)", async () => {
    render(<ChartThumb type="bar" data={DATA} overrides={OWN} onDrawn={() => {}} />);
    await waitFor(() => expect(h.built).toHaveLength(1));
    expect(h.built[0].seriesColors).toEqual({ Revenue: '#be185d' });
    expect(h.built[0].color).toBe('#e11d48');
  });

  it('accentOnly (Home): the accent only, and a redraw when the highlight changes', async () => {
    render(<ChartThumb type="bar" data={DATA} overrides={OWN} onDrawn={() => {}} accentOnly />);
    await waitFor(() => expect(h.built).toHaveLength(1));
    expect(h.built[0]).toMatchObject({ color: '#7c3aed', stacked: true, showLegend: false });
    expect(h.built[0].seriesColors).toBeUndefined();
    h.accent = '#0d9488';
    act(() => {
      document.documentElement.dataset.accent = 'teal';
    });
    await waitFor(() => expect(h.built).toHaveLength(2));
    expect(h.built[1].color).toBe('#0d9488');
    h.accent = '#7c3aed';
  });
});
