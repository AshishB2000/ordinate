// Click-to-filter's dimming (selection.ts): which marks are drawn at full
// strength and which step back, proven on the draw calls themselves — a fake
// element whose class `draw` records the alpha it was painted with.

import { describe, expect, it } from 'vitest';
import { buildChart } from './build';
import { DIM_ALPHA, selectionPlugin, type MarkSelection } from './selection';
import type { Cx } from './types';

class Mark {
  alpha: number | null = null;
  x = 1;
  y = 1;
  draw(ctx: Cx) {
    this.alpha = ctx.globalAlpha;
  }
}

function fakeCtx(): Cx {
  const stack: number[] = [];
  const dots: number[] = [];
  return {
    globalAlpha: 1,
    fillStyle: '#000',
    dots,
    save() {
      stack.push(this.globalAlpha);
    },
    restore() {
      this.globalAlpha = stack.pop() ?? 1;
    },
    beginPath() {},
    arc(x: number) {
      dots.push(x);
    },
    fill() {},
  };
}

/** Draw one frame the way Chart.js does: before → each element → after, per dataset. */
function frame(sel: MarkSelection, labels: string[], series: string[], opts: { raw?: string[]; line?: boolean } = {}) {
  const ctx = fakeCtx();
  const metas = series.map(() => ({ data: labels.map((_, i) => Object.assign(new Mark(), { x: i })), dataset: opts.line ? new Mark() : undefined, hidden: false }));
  const chart: Cx = { ctx, data: { labels, datasets: series.map((label) => ({ label, borderColor: '#123' })) }, getDatasetMeta: (i: number) => metas[i] };
  const plugin = selectionPlugin(sel, opts.raw ?? labels, labels);
  metas.forEach((meta, index) => {
    plugin.beforeDatasetDraw(chart, { index, meta });
    meta.dataset?.draw(ctx);
    for (const el of meta.data) el.draw(ctx);
    plugin.afterDatasetDraw(chart, { index, meta });
  });
  plugin.afterDatasetsDraw(chart);
  return { ctx, metas, alphas: metas.map((m) => m.data.map((el) => el.alpha)) };
}

describe('the selection on the clicked chart', () => {
  it('draws the picked categories at full strength and dims the rest — every category is still drawn', () => {
    const { alphas, ctx } = frame({ categories: ['West', 'North'] }, ['East', 'West', 'North'], ['Revenue']);
    expect(alphas).toEqual([[DIM_ALPHA, 1, 1]]);
    expect(ctx.globalAlpha).toBe(1); // the canvas is handed back as it came
  });

  it('on a split chart a mark needs its category AND its series', () => {
    const { alphas } = frame({ categories: ['West'], series: ['B2B'] }, ['East', 'West'], ['B2B', 'B2C']);
    expect(alphas).toEqual([
      [DIM_ALPHA, 1],
      [DIM_ALPHA, DIM_ALPHA],
    ]);
  });

  it('matches the SERVER’s label where the axis shows other text (a month axis)', () => {
    const { alphas } = frame({ categories: ['2023-02-01'] }, ['Jan 2023', 'Feb 2023'], ['Revenue'], { raw: ['2023-01-01', '2023-02-01'] });
    expect(alphas).toEqual([[DIM_ALPHA, 1]]);
  });

  it('a line steps back as a whole and its picked points are marked', () => {
    const { metas, ctx } = frame({ categories: ['West'] }, ['East', 'West', 'North'], ['Revenue'], { line: true });
    expect(metas[0].dataset?.alpha).toBe(DIM_ALPHA);
    expect(ctx.dots).toEqual([1]); // one dot, at West's point
  });

  it('leaves no wrapper behind: after the frame every element draws by its class again', () => {
    const { metas } = frame({ categories: ['West'] }, ['East', 'West'], ['Revenue'], { line: true });
    for (const m of metas) for (const el of [...m.data, m.dataset]) expect(Object.prototype.hasOwnProperty.call(el, 'draw')).toBe(false);
  });

  it('NEGATIVE CONTROL: with nothing picked nothing is dimmed', () => {
    expect(frame({}, ['East', 'West'], ['B2B', 'B2C']).alphas).toEqual([
      [1, 1],
      [1, 1],
    ]);
    expect(frame({ categories: [], series: [] }, ['East', 'West'], ['Revenue']).alphas).toEqual([[1, 1]]);
  });

  it('buildChart adds the plugin only when the card carries a selection', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const data = { labels: ['East', 'West'], series: [{ name: 'Revenue', values: [1, 2] }] };
    const ids = (overrides: Cx) => {
      const built = buildChart(canvas, data, 'column', overrides);
      return built?.kind === 'chartjs' ? built.config.plugins.map((p: Cx) => p.id) : [];
    };
    expect(ids({ markSelection: { categories: ['West'] } })).toContain('ordMarkSelection');
    expect(ids({})).not.toContain('ordMarkSelection');
    canvas.remove();
  });
});
