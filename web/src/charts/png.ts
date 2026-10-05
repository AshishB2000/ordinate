// A chart as a PNG — for report, deck and dashboard export (T2.13), the
// desktop's captureChartPNG (the desktop's reportExport.ts). A chart canvas is
// transparent, so the picture is composited onto an OPAQUE background: the
// theme surface, read off the element the chart was drawn in (an export frame
// can have its own), else white.

import { buildChart } from './build';
import { loadChartJs } from './loadChartJs';
import { getCSSVar } from './palette';
import { resolveChartType } from './typeSpec';
import type { ChartDataShape, Overrides } from './types';
import { buildWordCloud } from './wordCloud';

/** A drawn canvas over the theme surface, as a PNG data URL. */
export function canvasToPng(canvas: HTMLCanvasElement, surfaceFrom: Element = canvas): string {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('No 2-D canvas context');
  ctx.fillStyle = getCSSVar('--surface', surfaceFrom) || '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out.toDataURL('image/png');
}

/**
 * Draw a chart OFF-SCREEN at `width` × `height` CSS px, at 2× pixels, with no
 * animation (the final frame, not a mid-animation snapshot), and return it as
 * a PNG — or null when the data has nothing to draw. `host` is where the
 * off-screen box goes (and whose theme it takes): the document body by default.
 */
export async function renderChartPng(
  type: string,
  data: ChartDataShape,
  overrides: Overrides = {},
  { width = 1100, height = 620, host = document.body }: { width?: number; height?: number; host?: HTMLElement } = {},
): Promise<string | null> {
  const spec = resolveChartType(type);
  const ChartJs = spec.isWordCloud ? null : await loadChartJs(spec.chartType);
  const box = document.createElement('div');
  box.style.position = 'fixed';
  box.style.left = '-10000px';
  box.style.top = '0';
  box.style.width = `${Math.max(200, Math.round(width))}px`;
  box.style.height = `${Math.max(120, Math.round(height))}px`;
  const canvas = document.createElement('canvas');
  box.appendChild(canvas);
  host.appendChild(box);
  let destroy = (): void => {};
  try {
    const built = buildChart(canvas, data, type, { ...overrides, noAnimate: true, devicePixelRatio: 2 });
    if (!built) return null;
    if (built.kind === 'wordCloud') {
      destroy = buildWordCloud(canvas, built.labels, built.series, built.overrides, built.theme).destroy;
    } else {
      const chart = new ChartJs!(canvas, built.config as never);
      destroy = () => chart.destroy();
      chart.update('none'); // the final, animation-free frame before the pixels are read
    }
    await new Promise((r) => requestAnimationFrame(r));
    return canvasToPng(canvas, box);
  } finally {
    destroy();
    box.remove();
  }
}
