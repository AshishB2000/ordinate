// Click-to-filter's selection, on the chart that was clicked: the picked marks
// at full strength, every other mark dimmed (overrides.markSelection, set by
// the dashboard card — features/dashboards/CardRuntime.tsx). The chart keeps
// ALL its categories; this is paint only — a draw-time alpha over whatever
// fill the family chose (a gradient, a per-slice array, a scriptable colour),
// so no data, scale or figure changes and nothing here is computed from one.
//
// A mark is "picked" when its category is in `categories` AND its series is in
// `series` (each absent = every one) — the same rectangle the other cards are
// filtered to (dashboardFilters.ts clickFilterSteps).

import type { Cx } from './types';

export interface MarkSelection {
  /** The server's labels of the picked categories (not the axis text). */
  categories?: string[];
  /** The picked series names, on a chart split by series. */
  series?: string[];
}

/** How strongly an unpicked mark is drawn. */
export const DIM_ALPHA = 0.28;

/**
 * @param raw   the server's labels, as sent
 * @param shown the axis text for the same positions (a month axis reads "Jan 2023")
 */
export function selectionPlugin(sel: MarkSelection, raw: Cx[], shown: Cx[]): Cx {
  const cats = sel.categories?.length ? new Set(sel.categories) : null;
  const catOn = cats ? new Set(raw.flatMap((r, i) => (cats.has(String(r)) ? [String(shown[i])] : []))) : null;
  const sers = sel.series?.length ? new Set(sel.series) : null;
  const dimmed = (el: Cx) => {
    el.draw = function (ctx: Cx, ...rest: Cx[]) {
      ctx.save();
      ctx.globalAlpha *= DIM_ALPHA;
      Object.getPrototypeOf(el).draw.call(el, ctx, ...rest);
      ctx.restore();
    };
  };
  const seriesOff = (chart: Cx, i: number) => !!sers && chart.data.datasets.length > 1 && !sers.has(String(chart.data.datasets[i]?.label));
  const picked = (chart: Cx, i: number) => !catOn || catOn.has(String((chart.data.labels || [])[i]));
  return {
    id: 'ordMarkSelection',
    beforeDatasetDraw(chart: Cx, args: Cx) {
      const off = seriesOff(chart, args.index);
      // A line is one element for every category: it steps back whenever anything is picked, and its picked points are redrawn below.
      if (args.meta.dataset && (off || catOn)) dimmed(args.meta.dataset);
      (args.meta.data || []).forEach((el: Cx, i: number) => {
        if (off || !picked(chart, i)) dimmed(el);
      });
    },
    afterDatasetDraw(_chart: Cx, args: Cx) {
      // The wrappers live for one draw: an own `draw` removed, the element's class method is back.
      if (args.meta.dataset) delete args.meta.dataset.draw;
      for (const el of args.meta.data || []) delete el.draw;
    },
    afterDatasetsDraw(chart: Cx) {
      if (!catOn) return;
      const ctx = chart.ctx;
      chart.data.datasets.forEach((ds: Cx, d: number) => {
        const meta = chart.getDatasetMeta(d);
        if (!meta.dataset || meta.hidden || seriesOff(chart, d)) return;
        ctx.save();
        ctx.fillStyle = typeof ds.borderColor === 'string' ? ds.borderColor : ctx.fillStyle;
        (meta.data || []).forEach((el: Cx, i: number) => {
          if (!picked(chart, i) || !Number.isFinite(el.x) || !Number.isFinite(el.y)) return;
          ctx.beginPath();
          ctx.arc(el.x, el.y, 4.5, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
      });
    },
  };
}
