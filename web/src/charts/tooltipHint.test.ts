// The view page's click-to-filter hint (CardRuntime's `tooltipHint`): a chart whose marks filter the sheet says so
// under the figures in its tooltip; without the override the tooltip has no footer at all.

import { describe, expect, it } from 'vitest';
import { buildChart } from './build';
import type { Cx } from './types';

function tooltipOf(overrides: Cx): Cx {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const built = buildChart(canvas, { labels: ['East', 'West'], series: [{ name: 'Revenue', values: [1, 2] }] }, 'column', overrides);
  canvas.remove();
  if (built?.kind !== 'chartjs') throw new Error('expected a Chart.js config');
  return built.config.options.plugins.tooltip;
}

describe('tooltipHint', () => {
  it('becomes the tooltip footer, under the figures', () => {
    const tip = tooltipOf({ tooltipHint: 'Click to filter · ⌘-click picks several' });
    expect(tip.callbacks.footer()).toBe('Click to filter · ⌘-click picks several');
    expect(tip.footerMarginTop).toBe(8);
  });

  it('NEGATIVE CONTROL: no hint, no footer', () => {
    expect(tooltipOf({}).callbacks.footer).toBeUndefined();
    expect(tooltipOf({ tooltipHint: '' }).callbacks.footer).toBeUndefined();
  });
});
