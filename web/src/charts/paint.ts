// Dataset paint: the bar and area gradients and the prior-period overlay's
// muted ink (renderer/hub/chartDatasets.ts). Gradients return SCRIPTABLE
// options — Chart.js calls them back with a live chart, so each re-reads
// ctx.chart rather than closing over a chart area that does not exist yet.

import type { Cx } from './types';

// Bar: gradient along the bar's length, darkest at the value end.

export function makeBarGradient(color: string, isHoriz: boolean) {
  return (ctx: Cx) => {
    const chart = ctx.chart;
    const { ctx: cx, chartArea } = chart;
    if (!chartArea) return color + 'e0';
    let g;
    if (isHoriz) {
      // horizontal bars: subtle fade on left (base), full on right (value end)
      g = cx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
      g.addColorStop(0, color + 'b0');
      g.addColorStop(1, color + 'f2');
    } else {
      // vertical bars: full on top (value end), subtle fade at base
      g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      g.addColorStop(0, color + 'f2');
      g.addColorStop(1, color + 'b0');
    }
    return g;
  };
}

// Area fill: opaque near the line, transparent at the bottom.
export function makeAreaGradient(color: string) {
  return (ctx: Cx) => {
    const chart = ctx.chart;
    const { ctx: cx, chartArea } = chart;
    if (!chartArea) return color + '28';
    const g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, color + '50');
    g.addColorStop(1, color + '00');
    return g;
  };
}

/** A series colour at ~35% — the prior-period overlay's ink. Hex in, hex+alpha out. */
export function chartMuted(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(String(color)) ? color + '5c' : 'rgba(128, 128, 128, 0.4)';
}
